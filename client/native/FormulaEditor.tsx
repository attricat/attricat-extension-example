/* attribute_editor: a formula input for string fields. It suggests the
 * record's numeric attributes as you type and flags unknown names; Attricat
 * draws the field around it and saves what it proposes. */
import { useAttricat, useEditor, useLocale } from '@attricat/extension';
import { Badge, Stack, TextField } from '@attricat/ui-kit';
import { useEffect, useState } from 'preact/hooks';

const numericTypes = new Set(['number', 'integer']);
const identifier = /[A-Za-z_][A-Za-z0-9_]*/g;
const trailingIdentifier = /[A-Za-z_][A-Za-z0-9_]*$/;
const maximumSuggestions = 20;

type RecordResponse = { blueprint?: { attributes?: { code: string; value_type: string }[] } };

export const FormulaEditor = () => {
  const editor = useEditor<{ rows?: number }>();
  const attricat = useAttricat();
  const polish = useLocale().startsWith('pl');
  const [codes, setCodes] = useState<string[]>([]);
  const text = typeof editor.value === 'string' ? editor.value : '';

  useEffect(() => {
    void (attricat.request(`/api/v1/records/${editor.recordId}`) as Promise<RecordResponse>).then((record) =>
      setCodes(
        (record.blueprint?.attributes ?? [])
          .filter((attribute) => numericTypes.has(attribute.value_type))
          .map((attribute) => attribute.code)
          .sort(),
      ),
    );
  }, [editor.recordId]);

  // Complete values for the identifier being typed, as the host lists them.
  const prefix = text.match(trailingIdentifier)?.[0] ?? '';
  const suggestions = prefix
    ? codes
        .filter((code) => code.startsWith(prefix) && code !== prefix)
        .slice(0, maximumSuggestions)
        .map((code) => text.slice(0, text.length - prefix.length) + code)
    : [];
  const unknown = codes.length
    ? [...new Set(text.match(identifier) ?? [])].filter((name) => !codes.includes(name))
    : [];

  return (
    <Stack gap="xs">
      <TextField
        hideLabel
        label={editor.attribute.name}
        monospace
        onChange={({ value }) => editor.propose(value)}
        placeholder="price_net * (1 + vat_rate)"
        suggestions={suggestions}
        value={text}
      />
      {unknown.length > 0 && (
        <Stack direction="horizontal" gap="xs" wrap>
          {unknown.map((name) => (
            <Badge key={name} tone="warning" icon="alert">
              {polish ? `Nieznany atrybut: ${name}` : `Unknown attribute: ${name}`}
            </Badge>
          ))}
        </Stack>
      )}
    </Stack>
  );
};
