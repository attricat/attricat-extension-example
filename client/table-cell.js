export const mount = (root, catalog) => {
  const render = () => {
    const context = catalog.context ?? {};
    const value = context.primary_value;
    root.textContent = `Example cell: ${value ?? '—'}`;
    root.style.cssText = 'color:#1565c0;font-weight:600;padding:2px 0';
  };
  root.addEventListener('catalog:context-changed.v1', render);
  render();
  return () => root.removeEventListener('catalog:context-changed.v1', render);
};
