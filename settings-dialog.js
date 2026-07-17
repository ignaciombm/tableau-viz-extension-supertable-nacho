/**
 * Settings dialog for the Collapsible Grouping Table extension — opened via the "Format
 * Extension" button on the Marks card (see the <context-menu> entry in extension.trex and the
 * `configure` callback in application.js).
 *
 * Tableau dialogs are separate browser contexts: the only way data moves between this page and
 * the extension's main page is the payload passed into displayDialogAsync() (read here via
 * initializeDialogAsync) and the payload returned via closeDialog() when this page closes.
 */

let payload = null;
let draggedChip = null;
// True once the user actually drags a chip in this dialog session — distinguishes "order still
// tracking Marks card shelf position" from "user deliberately picked a custom order", so merely
// opening the dialog and clicking Save doesn't freeze every field's order.
let orderChangedByDrag = false;

tableau.extensions.initializeDialogAsync().then((openPayloadStr) => {
  payload = JSON.parse(openPayloadStr);
  document.getElementById('group-column-title').value = payload.groupColumnTitle || '';
  document.getElementById('group-title-italic').checked = !!payload.groupColumnTitleItalic;
  document.getElementById('group-values-italic').checked = !!payload.groupColumnValuesItalic;
  document.getElementById('group-values-color').value = payload.groupColumnValuesColor || '#000000';
  document.getElementById('default-expand-level').value = Number.isInteger(payload.defaultExpandLevel) ? payload.defaultExpandLevel : 0;
  renderFieldRows();
  renderOrderList();
  renderSortOptions();
  renderTotals();
});

// ============================================================================
// Default sort — which column (and direction) the table sorts by every rebuild
// ============================================================================

function renderSortOptions() {
  const select = document.getElementById('default-sort-field');
  select.innerHTML = '';

  if (payload.hierarchyFieldNames.length > 0) {
    const opt = document.createElement('option');
    opt.value = '_label';
    opt.textContent = payload.groupColumnTitle || 'Group';
    select.appendChild(opt);
  }
  [...payload.measureFieldNames, ...(payload.detailFieldNames || [])].forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = payload.fieldSettings[name]?.alias || name;
    select.appendChild(opt);
  });

  select.value = payload.defaultSortField || '_label';
  if (select.selectedIndex === -1 && select.options.length > 0) select.selectedIndex = 0;
  document.getElementById('default-sort-dir').value = payload.defaultSortDir === 'desc' ? 'desc' : 'asc';
}

function renderTotals() {
  document.getElementById('grand-total-enabled').checked = payload.totals.grandTotal.enabled;
  document.getElementById('grand-total-position').value = payload.totals.grandTotal.position;
  document.getElementById('subtotal-enabled').checked = payload.totals.subtotal.enabled;
  document.getElementById('subtotal-position').value = payload.totals.subtotal.position;
}

// ============================================================================
// Fields table — alias, filter, format (format applies to measures + detail columns;
// hierarchy fields only collapse into the shared tree column, so they skip it)
// ============================================================================

function renderFieldRows() {
  const tbody = document.getElementById('field-config-rows');
  tbody.innerHTML = '';

  const rows = [
    ...payload.hierarchyFieldNames.map((name) => ({ name, role: 'Hierarchy' })),
    ...payload.measureFieldNames.map((name) => ({ name, role: 'Measure' })),
    ...(payload.detailFieldNames || []).map((name) => ({ name, role: 'Detail' })),
  ];

  rows.forEach(({ name, role }) => {
    const setting = payload.fieldSettings[name] || { alias: name, filter: false };
    const tr = document.createElement('tr');
    tr.className = 'border-b';
    const formatCell = role !== 'Hierarchy' ? formatControlsHtml(name, setting.format) : '<span class="text-gray-500">—</span>';
    tr.innerHTML = `
      <td class="py-1 pr-2">${name}</td>
      <td class="py-1 pr-2 text-gray-500">${role}</td>
      <td class="py-1 pr-2">
        <input class="alias-input border rounded px-1 py-0.5 w-full" data-field="${name}" value="${setting.alias}" />
      </td>
      <td class="py-1 pr-2 text-center">
        <input type="checkbox" class="filter-checkbox" data-field="${name}" ${setting.filter ? 'checked' : ''} />
      </td>
      <td class="py-1 pr-2">${formatCell}</td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.alias-input').forEach((el) => el.addEventListener('input', (e) => {
    ensureSetting(e.target.dataset.field).alias = e.target.value;
  }));
  tbody.querySelectorAll('.filter-checkbox').forEach((el) => el.addEventListener('change', (e) => {
    ensureSetting(e.target.dataset.field).filter = e.target.checked;
  }));
}

function formatControlsHtml(name, format) {
  const f = format || { type: 'default', decimals: 0, thousandsSeparator: true, prefix: '', suffix: '', nullValue: '', titleItalic: false, valuesItalic: false, valuesColor: '#000000' };
  return `
    <div class="format-row" data-field="${name}">
      <select class="format-type" data-field="${name}">
        <option value="default" ${f.type === 'default' ? 'selected' : ''}>Default</option>
        <option value="number" ${f.type === 'number' ? 'selected' : ''}>Number</option>
        <option value="currency" ${f.type === 'currency' ? 'selected' : ''}>Currency</option>
        <option value="percent" ${f.type === 'percent' ? 'selected' : ''}>Percent</option>
      </select>
      <input type="number" min="0" max="6" class="format-decimals border rounded px-1 py-0.5 w-12" data-field="${name}" value="${f.decimals}" title="Decimals" />
      <input type="text" class="format-prefix border rounded px-1 py-0.5 w-12" data-field="${name}" value="${f.prefix}" placeholder="prefix" title="Prefix, e.g. $" />
      <input type="text" class="format-suffix border rounded px-1 py-0.5 w-12" data-field="${name}" value="${f.suffix}" placeholder="suffix" title="Suffix, e.g. %" />
      <label class="flex items-center gap-1" title="Use comma as thousands separator">
        <input type="checkbox" class="format-thousands" data-field="${name}" ${f.thousandsSeparator ? 'checked' : ''} /> 1,000
      </label>
      <input type="text" class="format-nullvalue border rounded px-1 py-0.5 w-14" data-field="${name}" value="${f.nullValue || ''}" placeholder="null/empty" title="Shown when this field is null/empty for a record" />
      <label class="flex items-center gap-1" title="Italicize this column's header">
        <input type="checkbox" class="format-title-italic" data-field="${name}" ${f.titleItalic ? 'checked' : ''} /> Italic title
      </label>
      <label class="flex items-center gap-1" title="Italicize this column's values">
        <input type="checkbox" class="format-values-italic" data-field="${name}" ${f.valuesItalic ? 'checked' : ''} /> Italic values
      </label>
      <label class="flex items-center gap-1" title="Color for this column's values">
        Color <input type="color" class="format-values-color" data-field="${name}" value="${f.valuesColor || '#000000'}" />
      </label>
    </div>
  `;
}

function ensureSetting(name) {
  if (!payload.fieldSettings[name]) payload.fieldSettings[name] = { alias: name, filter: false };
  return payload.fieldSettings[name];
}

function ensureFormat(name) {
  const s = ensureSetting(name);
  if (!s.format) s.format = { type: 'default', decimals: 0, thousandsSeparator: true, prefix: '', suffix: '', nullValue: '', titleItalic: false, valuesItalic: false, valuesColor: '#000000' };
  return s.format;
}

// ============================================================================
// Column order & visibility (measures + detail columns) — drag to reorder, checkbox to hide
// ============================================================================

function renderOrderList() {
  const container = document.getElementById('order-list');
  container.innerHTML = '';

  const ordered = [...payload.measureFieldNames, ...(payload.detailFieldNames || [])].sort((a, b) => {
    const oa = payload.fieldSettings[a]?.order ?? 0;
    const ob = payload.fieldSettings[b]?.order ?? 0;
    return oa - ob;
  });

  ordered.forEach((name) => {
    const setting = payload.fieldSettings[name] || {};
    const isHidden = setting.visible === false;
    const chip = document.createElement('div');
    chip.className = 'order-chip';
    chip.draggable = true;
    chip.dataset.field = name;
    chip.innerHTML = `
      <span class="handle">⋮⋮</span>
      <label class="flex items-center gap-1">
        <input type="checkbox" class="visible-checkbox" data-field="${name}" ${isHidden ? '' : 'checked'} />
      </label>
      <span class="name" style="${isHidden ? 'color:#9a9ca3; font-style:italic;' : ''}">${setting.alias || name}${isHidden ? ' (hidden — check to restore)' : ''}</span>
    `;
    container.appendChild(chip);
  });

  container.querySelectorAll('.visible-checkbox').forEach((el) => el.addEventListener('change', (e) => {
    ensureSetting(e.target.dataset.field).visible = e.target.checked;
    renderOrderList();
  }));

  container.querySelectorAll('.order-chip').forEach((chip) => {
    chip.addEventListener('dragstart', () => { draggedChip = chip; chip.classList.add('dragging'); });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('dragging');
      draggedChip = null;
      orderChangedByDrag = true;
      reorderFromDom();
    });
    chip.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedChip || draggedChip === chip) return;
      const rect = chip.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      container.insertBefore(draggedChip, before ? chip : chip.nextSibling);
    });
  });
}

function reorderFromDom() {
  Array.from(document.querySelectorAll('#order-list .order-chip')).forEach((chip, i) => {
    const s = ensureSetting(chip.dataset.field);
    s.order = i;
    // Only freeze this field's order once an actual drag happened — otherwise a plain Save
    // (list untouched) would needlessly stop it from tracking Marks card shelf position.
    if (orderChangedByDrag) s.orderManuallySet = true;
  });
}

// ============================================================================
// Collect + close
// ============================================================================

function collectFormValues() {
  payload.groupColumnTitle = document.getElementById('group-column-title').value;
  payload.groupColumnTitleItalic = document.getElementById('group-title-italic').checked;
  payload.groupColumnValuesItalic = document.getElementById('group-values-italic').checked;
  payload.groupColumnValuesColor = document.getElementById('group-values-color').value;
  payload.defaultExpandLevel = parseInt(document.getElementById('default-expand-level').value, 10) || 0;
  payload.defaultSortField = document.getElementById('default-sort-field').value;
  payload.defaultSortDir = document.getElementById('default-sort-dir').value;

  document.querySelectorAll('.alias-input').forEach((el) => { ensureSetting(el.dataset.field).alias = el.value; });
  document.querySelectorAll('.filter-checkbox').forEach((el) => { ensureSetting(el.dataset.field).filter = el.checked; });
  document.querySelectorAll('.format-type').forEach((el) => { ensureFormat(el.dataset.field).type = el.value; });
  document.querySelectorAll('.format-decimals').forEach((el) => { ensureFormat(el.dataset.field).decimals = parseInt(el.value, 10) || 0; });
  document.querySelectorAll('.format-prefix').forEach((el) => { ensureFormat(el.dataset.field).prefix = el.value; });
  document.querySelectorAll('.format-suffix').forEach((el) => { ensureFormat(el.dataset.field).suffix = el.value; });
  document.querySelectorAll('.format-thousands').forEach((el) => { ensureFormat(el.dataset.field).thousandsSeparator = el.checked; });
  document.querySelectorAll('.format-nullvalue').forEach((el) => { ensureFormat(el.dataset.field).nullValue = el.value; });
  document.querySelectorAll('.format-title-italic').forEach((el) => { ensureFormat(el.dataset.field).titleItalic = el.checked; });
  document.querySelectorAll('.format-values-italic').forEach((el) => { ensureFormat(el.dataset.field).valuesItalic = el.checked; });
  document.querySelectorAll('.format-values-color').forEach((el) => { ensureFormat(el.dataset.field).valuesColor = el.value; });
  document.querySelectorAll('.visible-checkbox').forEach((el) => { ensureSetting(el.dataset.field).visible = el.checked; });
  reorderFromDom();

  payload.totals.grandTotal.enabled = document.getElementById('grand-total-enabled').checked;
  payload.totals.grandTotal.position = document.getElementById('grand-total-position').value;
  payload.totals.subtotal.enabled = document.getElementById('subtotal-enabled').checked;
  payload.totals.subtotal.position = document.getElementById('subtotal-position').value;
}

document.getElementById('save-btn').addEventListener('click', () => {
  collectFormValues();
  tableau.extensions.ui.closeDialog(JSON.stringify({ action: 'save', ...payload }));
});

document.getElementById('autosize-btn').addEventListener('click', () => {
  collectFormValues();
  tableau.extensions.ui.closeDialog(JSON.stringify({ action: 'autosize', ...payload }));
});

document.getElementById('cancel-btn').addEventListener('click', () => {
  tableau.extensions.ui.closeDialog(JSON.stringify({ action: 'cancel' }));
});
