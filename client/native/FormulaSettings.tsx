/* blueprint_attribute_configuration, drawn natively: per-attribute rounding
 * and unit stored as attribute-scoped configuration. The event handler,
 * commands and the interactive run all round with these settings. */
import { useAttricat, useLocale, useOutletContext } from '@attricat/extension';
import { Button, Select, Stack, Text, TextField } from '@attricat/ui-kit';
import { useEffect, useState } from 'preact/hooks';
import { command, formulaIndexKey, storageGet, type FormulaIndex } from './attricat';

type Context = { blueprint_id: string; blueprint_version: number; attribute_id: string };
type Settings = { precision: number | null; unit: string | null };

const unrounded = 'unrounded';

export const FormulaSettings = () => {
  const context = useOutletContext<Context>();
  const attricat = useAttricat();
  const polish = useLocale().startsWith('pl');
  const [formula, setFormula] = useState<string>();
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<{ tone: 'muted' | 'success' | 'error'; text: string }>();
  const scope = {
    blueprint_id: context.blueprint_id,
    blueprint_version: context.blueprint_version,
    attribute_id: context.attribute_id,
  };

  useEffect(() => {
    void Promise.all([
      storageGet<FormulaIndex>(attricat, formulaIndexKey(context.blueprint_id, context.blueprint_version)),
      command<{ settings: Settings }>(attricat, 'get-attribute-settings', scope),
    ]).then(([index, answer]) => {
      setFormula(index?.formulas?.find((item) => item.target_attribute_id === context.attribute_id)?.expression);
      setSettings(answer.settings);
    });
  }, [context.blueprint_id, context.blueprint_version, context.attribute_id]);

  if (!settings || (!formula && settings.precision == null && !settings.unit)) return null;

  const save = async () => {
    setStatus({ tone: 'muted', text: polish ? 'Zapisywanie…' : 'Saving…' });
    try {
      await command(attricat, 'save-attribute-settings', { ...scope, settings });
      setStatus({ tone: 'success', text: polish ? 'Zapisano dla tej wersji.' : 'Saved for this revision.' });
    } catch {
      setStatus({ tone: 'error', text: polish ? 'Nie udało się zapisać.' : 'Could not save.' });
    }
  };

  return (
    <Stack gap="sm">
      {formula ? <Text monospace>{formula}</Text> : <Text tone="muted">{polish ? 'Ustawienia formuły' : 'Formula settings'}</Text>}
      <Stack direction="horizontal" gap="sm" align="center" wrap>
        <Select
          label={polish ? 'Miejsca po przecinku' : 'Decimal places'}
          onChange={({ value }) =>
            setSettings({ ...settings, precision: value === unrounded || value === null ? null : Number(value) })
          }
          options={[
            { value: unrounded, label: polish ? 'Bez zaokrąglania' : 'Unrounded' },
            ...[0, 1, 2, 3, 4, 5, 6].map((digits) => ({
              value: String(digits),
              label: polish ? `${digits} miejsc` : `${digits} decimals`,
            })),
          ]}
          value={settings.precision == null ? unrounded : String(settings.precision)}
        />
        <TextField
          label={polish ? 'Jednostka' : 'Unit'}
          maxLength={12}
          onChange={({ value }) => setSettings({ ...settings, unit: value.trim() || null })}
          value={settings.unit ?? ''}
        />
        <Button onPress={save}>{polish ? 'Zapisz' : 'Save'}</Button>
      </Stack>
      {status && <Text tone={status.tone === 'success' ? 'success' : status.tone} size="sm">{status.text}</Text>}
    </Stack>
  );
};
