export const mount = (root, catalog) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Example row action';
  button.addEventListener('click', () =>
    catalog.notify?.({ message: `Row action for ${catalog.context?.entity_id}` }),
  );
  root.append(button);
  return () => root.replaceChildren();
};
