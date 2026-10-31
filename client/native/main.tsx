/* The extension's native UI: one Worker for every client_native
 * contribution, each registered under its manifest id. */
import { register } from '@attricat/extension';
import { FormulaEditor } from './FormulaEditor';
import { FormulaSettings } from './FormulaSettings';

register('formula-settings', FormulaSettings);
register('formula-editor', FormulaEditor);
