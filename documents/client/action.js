// Compact selection action. It opens the host-managed dialog, which captures
// the current selection; this frame may unmount while the dialog stays open.
const palette = {
  light: { fg: '#1f2328', border: '#8c959f', bg: '#ffffff', hover: '#f3f4f6' },
  dark: { fg: '#e6edf3', border: '#6e7681', bg: '#161b22', hover: '#21262d' },
};

export const mount = (root, catalog) => {
  const button = document.createElement('button');
  button.type = 'button';
  const label = () => {
    const count = catalog.context?.record_ids?.length ?? 0;
    button.textContent =
      count > 1 ? `Generate documents (${count})` : 'Generate document';
    button.setAttribute(
      'aria-label',
      count > 1
        ? `Generate documents for ${count} selected records`
        : 'Generate a document for this record',
    );
  };
  const theme = () => {
    const colors = palette[catalog.theme?.color_mode] ?? palette.light;
    Object.assign(button.style, {
      font: '500 14px/20px system-ui, sans-serif',
      padding: '6px 12px',
      borderRadius: '6px',
      border: `1px solid ${colors.border}`,
      color: colors.fg,
      background: colors.bg,
      cursor: 'pointer',
    });
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await catalog.dialog.open();
    } catch {
      button.title = 'The document dialog could not be opened.';
    } finally {
      button.disabled = false;
    }
  });
  root.addEventListener('catalog:context-changed.v1', label);
  root.addEventListener('catalog:theme-changed.v1', theme);
  label();
  theme();
  root.replaceChildren(button);
  return () => {
    root.removeEventListener('catalog:context-changed.v1', label);
    root.removeEventListener('catalog:theme-changed.v1', theme);
    root.replaceChildren();
  };
};
