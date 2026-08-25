import { z } from "zod";

/**
 * Product principle 2.4: for boxed inventory,
 *   physicalQuantity = boxes × unitsPerBox + looseUnits
 * and this must be calculated and validated on the server — a client-supplied
 * total is never trusted. Every caller (manual counts, product intake, robot
 * observations) must compute the stored quantity through this function
 * rather than accepting one over the wire.
 */
export const physicalQuantityInputSchema = z.object({
  boxes: z.number().int("Las cajas deben ser un número entero.").min(0, "Las cajas no pueden ser negativas."),
  unitsPerBox: z
    .number()
    .int("Las unidades por caja deben ser un número entero.")
    .min(1, "Las unidades por caja deben ser al menos 1."),
  looseUnits: z
    .number()
    .int("Las unidades sueltas deben ser un número entero.")
    .min(0, "Las unidades sueltas no pueden ser negativas."),
});

export type PhysicalQuantityInput = z.infer<typeof physicalQuantityInputSchema>;

export function calculatePhysicalQuantity(input: PhysicalQuantityInput): number {
  const { boxes, unitsPerBox, looseUnits } = physicalQuantityInputSchema.parse(input);
  return boxes * unitsPerBox + looseUnits;
}
