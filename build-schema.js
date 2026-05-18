import fs, { existsSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Verifica l'esistenza del file types.ts prima di avviare il server
const typesFilePath = path.join(__dirname, 'types.ts');
if (!existsSync(typesFilePath)) {
    console.error("⛔ Errore: Il file types.ts non esiste. Questo file è necessario per il funzionamento del server. Per favore, crea il file e riavvia il server.");
    process.exit(1); // Termina il processo con un codice di errore
}

function generateSchemaFromTypes() {
  // Read the types.ts file
  const typesPath = path.join(__dirname, 'types.ts');
  const typesContent = fs.readFileSync(typesPath, 'utf-8');

  // Parse the TypeScript file
  const sourceFile = ts.createSourceFile(
    'types.ts',
    typesContent,
    ts.ScriptTarget.ESNext,
    true
  );

  // Find all type declarations (both exported and non-exported)
  const allTypes = new Map();
  const exportedTypes = [];
  
  ts.forEachChild(sourceFile, node => {
    if (ts.isTypeAliasDeclaration(node)) {
      const typeName = node.name.text;
      allTypes.set(typeName, node);
      
      if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        exportedTypes.push(node);
      }
    }
  });

  if (exportedTypes.length === 0) {
    console.error('⛔ Errore: Non sono stati trovati tipi esportati in types.ts. Assicurati di avere almeno un tipo esportato e riavvia il server.');
    process.exit(1); // Termina il processo con un codice di errore
  }

  // Generate schemas for all types
  const schemaImports = ['import z from \'zod\';'];
  const schemaDefinitions = [];
  const validationFunctions = [];
  const exportedValidators = [];
  const readonlyPropertiesList = [];
  const typeSchemaMap = new Map();

  // First pass: Generate schemas for all types (including non-exported)
  for (const [typeName, typeDecl] of allTypes) {
    const schemaName = `${typeName}Schema`;
    const isExported = exportedTypes.includes(typeDecl);
    
    // Track readonly properties for this type
    const readonlyProperties = [];

    // Generate Zod schema based on the properties in the type
    const schemaProperties = [];
    
    // Track if required properties are present for exported types
    const hasTitle = { present: false };
    const hasCategory = { present: false };
    
    if (ts.isTypeLiteralNode(typeDecl.type)) {
      typeDecl.type.members.forEach(member => {
        if (ts.isPropertySignature(member) && member.name) {
          const propName = member.name.getText(sourceFile);
          const isOptional = member.questionToken !== undefined;
          const isReadonly = hasModifier(member, ts.SyntaxKind.ReadonlyKeyword);
          
          // Track readonly properties
          if (isReadonly) {
            readonlyProperties.push(propName);
          }
          
          // Skip readonly properties for validation as they're set by the server
          if (propName === 'id' || propName === 'createdAt' || propName === 'updatedAt') {
            return;
          }
          
          // For exported types, track required properties
          if (isExported) {
            if (propName === 'title') {
              hasTitle.present = true;
              // Ensure title is a string
              schemaProperties.push(`  ${propName}: z.string({ required_error: "Title is required" })${isOptional ? '.optional()' : ''},`);
              return;
            } 
            else if (propName === 'category') {
              hasCategory.present = true;
              // Ensure category is a string
              schemaProperties.push(`  ${propName}: z.string({ required_error: "Category is required" })${isOptional ? '.optional()' : ''},`);
              return;
            }
          }
          
          let zodType = generateZodTypeForNode(member.type, sourceFile, propName, allTypes);
          
          // Add optional modifier if needed
          if (isOptional) {
            zodType = `${zodType}.optional()`;
          }
          
          // Add a comment for readonly properties
          const readonlyComment = isReadonly ? ' // readonly in TypeScript' : '';
          
          schemaProperties.push(`  ${propName}: ${zodType},${readonlyComment}`);
        }
      });
    }
    
    // Force add required properties if missing for exported types
    if (isExported) {
      if (!hasTitle.present) {
        schemaProperties.push(`  title: z.string({ required_error: "Title is required" })`);
      }
      if (!hasCategory.present) {
        schemaProperties.push(`  category: z.string({ required_error: "Category is required" })`);
      }
    }

    // Define the schema
    const schemaDefinition = `
// Schema generated from types.ts ${typeName} type
${isExported ? 'export ' : ''}const ${schemaName} = z.object({
  ${isExported ? 'id: z.number().optional(),\n  createdAt: z.string().optional(),\n  updatedAt: z.string().optional(),\n' : ''}${schemaProperties.join('\n')}
}).strict(); // Add strict mode to reject extra properties`;

    // Store in the map for reference by other types
    typeSchemaMap.set(typeName, schemaName);
    
    if (isExported) {
      // Add this type's readonly properties to the master list
      readonlyPropertiesList.push(`  "${typeName.toLowerCase()}": [${readonlyProperties.map(prop => `"${prop}"`).join(', ')}]`);
      schemaDefinitions.push(schemaDefinition);
      
      // Add validation function
      const validatorName = `validate${typeName}`;
      exportedValidators.push(validatorName);
      
      validationFunctions.push(`
export function ${validatorName}(data) {
  try {
    const result = ${schemaName}.parse(data);
    return { valid: true, data: result };
  } catch (error) {
    return { 
      valid: false, 
      errors: error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message
      }))
    };
  }
}`);
    } else {
      // For non-exported types, just add the schema definition
      schemaDefinitions.push(schemaDefinition);
    }
  }

  // Generate the schema.js content
  const schemaContent = `// THIS FILE IS AUTO-GENERATED from types.ts - DO NOT EDIT DIRECTLY
${schemaImports.join('\n')}

${schemaDefinitions.join('\n')}

${validationFunctions.join('\n')}

// Export all validators as a map for dynamic usage
export const validators = {
  ${exportedValidators.map(name => `"${name.replace('validate', '').toLowerCase()}": ${name}`).join(',\n  ')}
};

// Export readonly properties for each type to prevent updates
export const readonlyProperties = {
${readonlyPropertiesList.join(',\n')}
};
`;

  // Write the schema.js file
  const schemaPath = path.join(__dirname, 'schema.js');
  fs.writeFileSync(schemaPath, schemaContent);
  console.log('Generato schema.js da types.ts');
}

// Helper function to check if a node has a specific modifier
function hasModifier(node, modifierKind) {
  return node.modifiers && node.modifiers.some(mod => mod.kind === modifierKind);
}

// Generate Zod validation for different TypeScript types
function generateZodTypeForNode(typeNode, sourceFile, propName, allTypes) {
  if (!typeNode) return 'z.any()';
  
  // Handle different TypeScript types
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) {
    return 'z.string()';
  } 
  else if (typeNode.kind === ts.SyntaxKind.NumberKeyword) {
    return 'z.number()';
  } 
  else if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
    return 'z.boolean()';
  } 
  else if (ts.isArrayTypeNode(typeNode)) {
    const elementType = generateZodTypeForNode(typeNode.elementType, sourceFile, propName, allTypes);
    return `z.array(${elementType})`;
  } 
  else if (ts.isUnionTypeNode(typeNode)) {
    // Extract readable type descriptions for the error message
    const typeDescriptions = typeNode.types.map(t => {
      if (ts.isLiteralTypeNode(t)) {
        if (ts.isStringLiteral(t.literal)) return `'${t.literal.text}'`;
        if (ts.isNumericLiteral(t.literal)) return t.literal.text;
        if (t.literal.kind === ts.SyntaxKind.TrueKeyword) return 'true';
        if (t.literal.kind === ts.SyntaxKind.FalseKeyword) return 'false';
        if (t.literal.kind === ts.SyntaxKind.NullKeyword) return 'null';
      }
      if (t.kind === ts.SyntaxKind.StringKeyword) return 'string';
      if (t.kind === ts.SyntaxKind.NumberKeyword) return 'number';
      if (t.kind === ts.SyntaxKind.BooleanKeyword) return 'boolean';
      if (ts.isTypeReferenceNode(t)) return t.typeName.getText(sourceFile);
      
      return 'other';
    });
    
    // Format options for error message - join with commas and 'or' for last item
    const formattedOptions = typeDescriptions.length > 1 
      ? typeDescriptions.slice(0, -1).join(', ') + ' or ' + typeDescriptions[typeDescriptions.length - 1]
      : typeDescriptions[0];
    
    // Create custom error message for the union
    const errorMsg = `Invalid value for '${propName}'. Expected ${formattedOptions}`;
    
    // Check if all types in the union are string literals (for enum optimization)
    const allStringLiterals = typeNode.types.every(t => 
      ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)
    );
    
    if (allStringLiterals) {
      // Extract string values for enum
      const enumValues = typeNode.types.map(t => 
        ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : ''
      );
      
      // Use z.enum() for better error messages with string literals
      return `z.enum([${enumValues.map(v => `"${v}"`).join(', ')}], {
        errorMap: () => ({ message: "${errorMsg}" })
      })`;
    }
    
    return `z.union([${typeDescriptions.map(desc => `z.literal(${desc})`).join(', ')}], { invalid_type_error: "${errorMsg}" })`;
  } 
  else if (ts.isLiteralTypeNode(typeNode)) {
    if (ts.isStringLiteral(typeNode.literal)) {
      return `z.literal("${typeNode.literal.text}")`;
    } else if (ts.isNumericLiteral(typeNode.literal)) {
      return `z.literal(${typeNode.literal.text})`;
    } else if (typeNode.literal.kind === ts.SyntaxKind.TrueKeyword) {
      return 'z.literal(true)';
    } else if (typeNode.literal.kind === ts.SyntaxKind.FalseKeyword) {
      return 'z.literal(false)';
    } else if (typeNode.literal.kind === ts.SyntaxKind.NullKeyword) {
      return 'z.literal(null)';
    }
    return 'z.any()';
  } 
  else if (ts.isTupleTypeNode(typeNode)) {
    // Check if there is a rest element in the tuple
    const hasRestElement = typeNode.elements.some(e => ts.isRestTypeNode(e));
    
    if (hasRestElement) {
      // Find the index of the rest element
      const restIndex = typeNode.elements.findIndex(e => ts.isRestTypeNode(e));
      
      // Generate types for elements before the rest element
      const regularTypes = typeNode.elements
        .slice(0, restIndex)
        .map(e => generateZodTypeForNode(e, sourceFile, propName, allTypes));
      
      // Generate type for the rest element
      const restElement = typeNode.elements[restIndex];
      let restElementType;
      
      if (ts.isRestTypeNode(restElement) && ts.isArrayTypeNode(restElement.type)) {
        // If the rest element is an array type, get the element type directly
        restElementType = generateZodTypeForNode(restElement.type.elementType, sourceFile, propName, allTypes);
      } else if (ts.isRestTypeNode(restElement)) {
        // Other types in the rest element
        restElementType = generateZodTypeForNode(restElement.type, sourceFile, propName, allTypes);
        // If it's an array wrapped, extract the element type
        if (restElementType.startsWith('z.array(')) {
          restElementType = restElementType.substring(8, restElementType.length - 1);
        }
      } else {
        // Not a rest element, just use it directly
        restElementType = generateZodTypeForNode(restElement, sourceFile, propName, allTypes);
      }
      
      // Create a tuple with rest
      return `z.tuple([${regularTypes.join(', ')}]).rest(${restElementType})`;
    } else {
      // Regular tuple without rest elements
      const tupleTypes = typeNode.elements.map(e => generateZodTypeForNode(e, sourceFile, propName, allTypes));
      return `z.tuple([${tupleTypes.join(', ')}])`;
    }
  } 
  else if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sourceFile);
    
    if (typeName === 'Date') {
      return 'z.string().datetime("Invalid date format")';
    }
    
    // Check if this is a reference to a custom type we've already defined
    if (allTypes.has(typeName)) {
      const referencedType = allTypes.get(typeName);
      
      // Check if the referenced type is a union of string literals (like our Platform, GameMode, etc.)
      if (referencedType.type && ts.isUnionTypeNode(referencedType.type)) {
        const allStringLiterals = referencedType.type.types.every(t => 
          ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)
        );
        
        if (allStringLiterals) {
          // Extract string values for enum
          const enumValues = referencedType.type.types.map(t => 
            ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : ''
          );
          
          // Return enum directly for better validation of string literals
          return `z.enum([${enumValues.map(v => `"${v}"`).join(', ')}], {
            errorMap: () => ({ message: "Invalid value for '${propName}'. Expected one of the allowed values for ${typeName}." })
          })`;
        }
      }
      
      // Otherwise, use the schema we generated for this type
      return `${typeName}Schema`;
    }
    
    return 'z.any()';
  }
  else if (typeNode.kind === ts.SyntaxKind.ObjectKeyword) {
    return 'z.record(z.any())';
  }
  
  // For any other types
  return 'z.any()';
}

generateSchemaFromTypes();
