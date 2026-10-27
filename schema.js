// THIS FILE IS AUTO-GENERATED from types.ts - DO NOT EDIT DIRECTLY
import z from 'zod';


// Schema generated from types.ts Travel type
export const TravelSchema = z.object({
  id: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  title: z.string({ required_error: "Title is required" }),
  category: z.string({ required_error: "Category is required" }),
  destination: z.string(),
  durationDay: z.number(),
  price: z.number(),
  difficulty: z.enum(["Facile", "Intermedio", "Difficile", "Estremo"], {
        errorMap: () => ({ message: "Invalid value for 'difficulty'. Expected 'Facile', 'Intermedio', 'Difficile' or 'Estremo'" })
      }),
  adrenalineLevel: z.number(),
  image: z.string(),
  description: z.string(),
  requiredEquipment: z.array(z.string()),
}).strict(); // Add strict mode to reject extra properties


export function validateTravel(data) {
  try {
    const result = TravelSchema.parse(data);
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
}

// Export all validators as a map for dynamic usage
export const validators = {
  "travel": validateTravel
};

// Export readonly properties for each type to prevent updates
export const readonlyProperties = {
  "travel": []
};
