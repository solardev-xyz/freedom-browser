// The UI catalog (ui-catalog.html, #1198) writes its blocks once and shows
// them in both themes: each column carries `data-theme`, which tokens.css
// honours on any element, so the same markup paints dark on the left and
// light on the right.
const blocks = document.getElementById('catalog-blocks');
for (const column of document.querySelectorAll('[data-catalog-column]')) {
  column.append(blocks.content.cloneNode(true));
}
