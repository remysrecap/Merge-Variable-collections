/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 320, height: 400 });

interface VariableInfo {
  id: string;
  name: string;
  resolvedType: VariableResolvedDataType;
}

async function getNextVersionNumber(): Promise<string> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const versionPattern = /Combo (\d+\.\d+)/;
  let highestVersion = 0.9;  // Start at 0.9 so first version will be 1.0

  collections.forEach(collection => {
    const match = collection.name.match(versionPattern);
    if (match) {
      const version = parseFloat(match[1]);
      if (version > highestVersion) {
        highestVersion = version;
      }
    }
  });

  return (highestVersion + 0.1).toFixed(1);
}

async function getCollectionVariables(collection: VariableCollection): Promise<VariableInfo[]> {
  const allVariables = await figma.variables.getLocalVariablesAsync();
  return allVariables
    .filter(v => v.variableCollectionId === collection.id)
    .map(v => ({
      id: v.id,
      name: v.name,
      resolvedType: v.resolvedType
    }));
}

function compareVariables(vars1: VariableInfo[], vars2: VariableInfo[]): number {
  const set1 = new Set(vars1.map(v => `${v.name}:${v.resolvedType}`));
  const set2 = new Set(vars2.map(v => `${v.name}:${v.resolvedType}`));
  
  return [...set1].filter(x => !set2.has(x)).length + 
         [...set2].filter(x => !set1.has(x)).length;
}

async function processCollection(
  sourceCollection: VariableCollection,
  targetCollection: VariableCollection,
  firstCollection: boolean,
  isUpdate: boolean
): Promise<void> {
  const sourceModes = sourceCollection.modes;
  const shouldAppendMode = sourceModes.length > 1;

  // If updating an existing collection and this is the target collection, skip mode creation
  if (isUpdate && firstCollection) {
    return;
  }

  for (const mode of sourceModes) {
    const modeName = shouldAppendMode 
      ? `${sourceCollection.name} (${mode.name})`
      : sourceCollection.name;

    let newModeId: string;
    if (firstCollection && !isUpdate) {
      // For new collections, rename the first mode
      newModeId = targetCollection.modes[0].modeId;
      targetCollection.renameMode(newModeId, modeName);
    } else {
      // Add new modes only for non-first collection or when creating new collection
      newModeId = targetCollection.addMode(modeName);
    }

    const variables = await getCollectionVariables(sourceCollection);
    for (const varInfo of variables) {
      const sourceVar = await figma.variables.getVariableByIdAsync(varInfo.id);
      if (!sourceVar) continue;

      let targetVar: Variable;
      const existingVars = await getCollectionVariables(targetCollection);
      const existingVar = existingVars.find(v => v.name === varInfo.name);

      if (existingVar) {
        const existing = await figma.variables.getVariableByIdAsync(existingVar.id);
        if (existing) targetVar = existing;
        else continue;
      } else {
        targetVar = figma.variables.createVariable(
          varInfo.name,
          targetCollection,
          varInfo.resolvedType
        );
      }

      const modeValue = sourceVar.valuesByMode[mode.modeId];
      if (targetVar && modeValue !== undefined) {
        targetVar.setValueForMode(newModeId, modeValue);
      }
    }
  }
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'get-collections') {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    figma.ui.postMessage({ 
      type: 'collections',
      collections: collections.map(c => ({
        id: c.id,
        name: c.name
      }))
    });
  } else if (msg.type === 'merge-collections') {
    try {
      const collection1 = await figma.variables.getVariableCollectionByIdAsync(msg.collection1Id);
      const collection2 = await figma.variables.getVariableCollectionByIdAsync(msg.collection2Id);
      
      if (!collection1 || !collection2) {
        figma.ui.postMessage({ type: 'error', message: 'One or more collections not found' });
        return;
      }

      const vars1 = await getCollectionVariables(collection1);
      const vars2 = await getCollectionVariables(collection2);
      
      const differences = compareVariables(vars1, vars2);
      if (differences > 0) {
        figma.ui.postMessage({ 
          type: 'error', 
          message: `Collections have ${differences} variable inconsistencies. Variables must be identical across collections.` 
        });
        return;
      }

      let targetCollection: VariableCollection;
      const isUpdate = msg.saveAs !== 'new';

      if (isUpdate) {
        const existingCollection = await figma.variables.getVariableCollectionByIdAsync(msg.saveAs);
        if (!existingCollection) {
          figma.ui.postMessage({ type: 'error', message: 'Target collection not found' });
          return;
        }
        targetCollection = existingCollection;
      } else {
        const version = await getNextVersionNumber();
        targetCollection = figma.variables.createVariableCollection(`Combo ${version}`);
      }

      await processCollection(collection1, targetCollection, true, isUpdate);
      await processCollection(collection2, targetCollection, false, isUpdate);

      figma.ui.postMessage({ type: 'success' });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      figma.ui.postMessage({ type: 'error', message: errorMessage });
    }
  } else if (msg.type === 'close' || msg.type === 'cancel') {
    figma.closePlugin();
  }
};