// THIS FILE IS AUTO-GENERATED from types.ts - DO NOT EDIT DIRECTLY
import { z } from 'zod';

export type ValidationError = { field: string; message: string };
export type ValidationResult<T> = { valid: true; data: T } | { valid: false; errors: ValidationError[] };
export type Validator = (data: unknown) => ValidationResult<Record<string, unknown>>;


// Schema generated from types.ts Travel type
export const TravelSchema = z.object({
  id: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  title: z.string({ error: (iss) => iss.input === undefined ? "Title is required" : undefined }),
  category: z.string({ error: (iss) => iss.input === undefined ? "Category is required" : undefined }),
  destination: z.string(),
  durationDay: z.number(),
  price: z.number(),
  difficulty: z.enum(["Facile", "Intermedio", "Difficile", "Estremo"], {
        error: "Invalid value for 'difficulty'. Expected 'Facile', 'Intermedio', 'Difficile' or 'Estremo'"
      }),
  adrenalineLevel: z.number(),
  image: z.string(),
  description: z.string(),
  requiredEquipment: z.array(z.string()),
}).strict(); // Add strict mode to reject extra properties


export function validateTravel(data: unknown): ValidationResult<z.infer<typeof TravelSchema>> {
  const result = TravelSchema.safeParse(data);
  if (result.success) return { valid: true, data: result.data };
  return {
    valid: false,
    errors: result.error.issues.map(issue => ({
      // path può contenere simboli: String() evita un TypeError in join
      field: issue.path.map(String).join('.'),
      message: issue.message
    }))
  };
}

// Export all validators as a map for dynamic usage
export const validators: Record<string, Validator> = {
  "travel": validateTravel
};

// Export readonly properties for each type to prevent updates
export const readonlyProperties: Record<string, string[]> = {
  "travel": []
};
