/** The TOML table at `[extensions.attricat-extension-example.formulas]`. */
export type BlueprintFormulaMetadata = Record<string, string>;

/** Runtime form after formula codes have been resolved against a blueprint. */
export type FormulaConfig = {
  targetAttributeId: string;
  expression: string;
  dependencies: string[];
};

export type FormulaPreview = {
  result: number;
  dependencies: string[];
  resolvedInputs: Record<string, number | null>;
};

export type FormulaCalculation = {
  targetAttributeId: string;
  result: number;
  written: boolean;
};
