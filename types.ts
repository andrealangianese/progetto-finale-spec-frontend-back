export type Travel = {
  title: string;
  category: string;
  destination: string;
  durationDay: number;
  price: number;
  difficulty: "Facile" | "Intermedio" | "Difficile" | "Estremo";
  adrenalineLevel: number;
  image: string;
  description: string;
  requiredEquipment: string[];
};
