/**
 * Collapsible Grouping Table — Tableau Viz Extension
 *
 * This runs INSIDE a worksheet (added via the Marks card "Add Extension" flow), not on a
 * dashboard. The user drags fields onto three custom shelves declared in extension.trex:
 *   - "hierarchy": one or more dimensions, defining the parent -> child grouping order
 *     (drag order on that shelf IS the hierarchy order — Tableau handles the reordering UI).
 *   - "measures":  one or more numeric fields to aggregate.
 *   - "details":   optional dimensions shown as plain, ungrouped columns — their value only
 *     appears on leaf-level records, blank on every group/subtotal/grand-total row.
 *
 * Data flow:
 *   1. getVisualSpecificationAsync() tells us which fields are currently on each shelf.
 *   2. getSummaryDataAsync() gives us the worksheet's flat summary rows.
 *   3. buildTree() turns the flat rows into a nested tree keyed by the hierarchy fields,
 *      which Tabulator renders natively with collapse/expand (dataTree mode).
 *
 * Per-field aliases/inline-filters and the totals/subtotals config are set in a separate
 * dialog page (settings-dialog.html), opened via the "Format Extension" button on the Marks
 * card (see <context-menu> in extension.trex), and persisted via tableau.extensions.settings.
 */

const SETTINGS_KEY = 'collapsibleGroupingTableConfig';

const DEFAULT_FORMAT = {
  type: 'default', decimals: 0, thousandsSeparator: true, prefix: '', suffix: '', nullValue: '',
  titleItalic: false, valuesItalic: false, valuesColor: '#000000',
};

const state = {
  worksheet: null,
  hierarchyFieldNames: [], // ordered, as dropped on the "hierarchy" shelf
  measureFieldNames: [],   // as dropped on the "measures" shelf
  detailFieldNames: [],    // as dropped on the "details" shelf — shown per-record, not grouped
  valueFieldOrder: [],     // measures+details combined, in Tableau's true Marks card shelf order
  groupColumnTitle: null,  // custom title for the tree/group column; defaulted on first load
  groupColumnTitleItalic: false,
  groupColumnValuesItalic: false,
  groupColumnValuesColor: '#000000',
  groupColumnWidth: null,  // persisted px width for the tree column, once manually resized
  defaultExpandLevel: 0,   // how many hierarchy levels start expanded when the table (re)builds
  zoomLevel: 100,          // CSS zoom percentage applied to the whole grid
  // Which column the table sorts by every time it (re)builds. Tableau doesn't guarantee stable
  // row order for an aggregate query across sessions, so without an explicit persisted sort the
  // displayed order drifts every time the extension reloads — this pins it down for good.
  defaultSortField: '_label',
  defaultSortDir: 'asc',
  // When true, every configured inline filter shows permanently in a row below the headers
  // (Tabulator's native header-filter markup) instead of behind a toggle icon.
  filtersAlwaysVisible: true,
  // { [fieldName]: { alias, filter, visible, order, width, format } } — visible/order/width/
  // format apply to both measure and detail fields (hierarchy fields collapse into one tree
  // column, whose own width is tracked separately via groupColumnWidth above).
  fieldSettings: {},
  totals: {
    grandTotal: { enabled: false, position: 'bottom' },
    subtotal: { enabled: false, position: 'bottom' },
  },
  lastFlatRows: [],
  table: null,
};

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `row_${idCounter}`;
}

// ============================================================================
// Bootstrapping
// ============================================================================

tableau.extensions.initializeAsync({ configure: openConfigureDialog }).then(() => {
  loadSettings();
  state.worksheet = tableau.extensions.worksheetContent.worksheet;
  state.worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh);
  refresh();
}).catch((err) => showEmptyView(`Failed to initialize: ${err}`));

function loadSettings() {
  const raw = tableau.extensions.settings.get(SETTINGS_KEY);
  if (!raw) return;
  const saved = JSON.parse(raw);
  state.fieldSettings = saved.fieldSettings || {};
  state.totals = saved.totals || state.totals;
  state.groupColumnTitle = saved.groupColumnTitle || null;
  state.groupColumnTitleItalic = !!saved.groupColumnTitleItalic;
  state.groupColumnValuesItalic = !!saved.groupColumnValuesItalic;
  state.groupColumnValuesColor = saved.groupColumnValuesColor || '#000000';
  state.groupColumnWidth = Number.isFinite(saved.groupColumnWidth) ? saved.groupColumnWidth : null;
  state.defaultExpandLevel = Number.isInteger(saved.defaultExpandLevel) ? saved.defaultExpandLevel : 0;
  state.zoomLevel = Number.isFinite(saved.zoomLevel) ? saved.zoomLevel : 100;
  state.defaultSortField = saved.defaultSortField || '_label';
  state.defaultSortDir = saved.defaultSortDir === 'desc' ? 'desc' : 'asc';
  if (saved.filtersAlwaysVisible !== undefined) state.filtersAlwaysVisible = !!saved.filtersAlwaysVisible;
}

function persistSettings() {
  tableau.extensions.settings.set(SETTINGS_KEY, JSON.stringify({
    fieldSettings: state.fieldSettings,
    totals: state.totals,
    groupColumnTitle: state.groupColumnTitle,
    groupColumnTitleItalic: state.groupColumnTitleItalic,
    groupColumnValuesItalic: state.groupColumnValuesItalic,
    groupColumnValuesColor: state.groupColumnValuesColor,
    groupColumnWidth: state.groupColumnWidth,
    defaultExpandLevel: state.defaultExpandLevel,
    zoomLevel: state.zoomLevel,
    defaultSortField: state.defaultSortField,
    defaultSortDir: state.defaultSortDir,
    filtersAlwaysVisible: state.filtersAlwaysVisible,
  }));
  return tableau.extensions.settings.saveAsync();
}

function switchView(viewId) {
  ['empty-view', 'table-view'].forEach((id) => {
    document.getElementById(id).classList.toggle('hidden', id !== viewId);
  });
}

function showEmptyView(errorMessage) {
  const errorEl = document.getElementById('empty-error');
  if (errorMessage) {
    errorEl.textContent = errorMessage;
    errorEl.classList.remove('hidden');
  } else {
    errorEl.classList.add('hidden');
  }
  switchView('empty-view');
}

// ============================================================================
// Refresh cycle — re-reads encodings + data any time the shelves or filters change
// ============================================================================

async function refresh() {
  try {
    const { hierarchy, measures, details, valueFieldOrder } = await getEncodingMap(state.worksheet);
    state.hierarchyFieldNames = hierarchy;
    state.measureFieldNames = measures;
    state.detailFieldNames = details;
    state.valueFieldOrder = valueFieldOrder;

    // A measure is always required; hierarchy (grouping) and details (ungrouped columns) are
    // each optional, but at least one of the two must be present — otherwise there's nothing
    // to show besides a bare measure with no row identity at all.
    if (measures.length === 0 || (hierarchy.length === 0 && details.length === 0)) {
      showEmptyView();
      return;
    }

    ensureFieldSettingsDefaults();
    state.lastFlatRows = await getSummaryDataTable(state.worksheet);

    rebuildTable();
    applyZoom();
    switchView('table-view');
  } catch (err) {
    showEmptyView(`Failed to load data: ${err}`);
  }
}

// ============================================================================
// Zoom control — scales the whole grid via CSS zoom (persisted like everything else)
// ============================================================================

function applyZoom() {
  document.getElementById('grid-table').style.zoom = `${state.zoomLevel}%`;
  document.getElementById('zoom-level').textContent = `${state.zoomLevel}%`;
}

function adjustZoom(delta) {
  state.zoomLevel = Math.min(200, Math.max(50, state.zoomLevel + delta));
  applyZoom();
  persistSettings();
  if (state.table) state.table.redraw(true);
}

document.getElementById('zoom-in-btn').addEventListener('click', () => adjustZoom(10));
document.getElementById('zoom-out-btn').addEventListener('click', () => adjustZoom(-10));

// ============================================================================
// Export control — CSV needs no extra library; Excel uses the vendored SheetJS
// (lib/xlsx.full.min.js), which Tabulator's download('xlsx', ...) picks up automatically.
// ============================================================================

function exportFileBaseName() {
  return (state.groupColumnTitle || 'table').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'table';
}

document.getElementById('export-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('export-menu').classList.toggle('hidden');
});
document.addEventListener('click', () => document.getElementById('export-menu').classList.add('hidden'));

document.getElementById('export-csv-btn').addEventListener('click', () => {
  if (state.table) state.table.download('csv', `${exportFileBaseName()}.csv`);
});
document.getElementById('export-xlsx-btn').addEventListener('click', () => {
  if (state.table) state.table.download('xlsx', `${exportFileBaseName()}.xlsx`, { sheetName: 'Data' });
});

/** Maps the "hierarchy", "measures" and "details" shelves (declared in extension.trex) to the
 *  field names the user has dropped on them, preserving shelf order.
 *
 *  `valueFieldOrder` is measures+details combined in the ACTUAL order Tableau reports them in
 *  `marksCard.encodings` — not a hardcoded [measures, details] concatenation — so the default
 *  column order genuinely follows the Marks card's real shelf arrangement (details above
 *  measures, per extension.trex's encoding order) rather than an assumption made in this code. */
async function getEncodingMap(worksheet) {
  const visualSpec = await worksheet.getVisualSpecificationAsync();
  const marksCard = visualSpec.marksSpecifications[visualSpec.activeMarksSpecificationIndex];

  const hierarchy = [];
  const measures = [];
  const details = [];
  const valueFieldOrder = [];
  marksCard.encodings.forEach((encoding) => {
    if (!encoding.field) return;
    if (encoding.id === 'hierarchy') hierarchy.push(encoding.field.name);
    if (encoding.id === 'measures') { measures.push(encoding.field.name); valueFieldOrder.push(encoding.field.name); }
    if (encoding.id === 'details') { details.push(encoding.field.name); valueFieldOrder.push(encoding.field.name); }
  });
  return { hierarchy, measures, details, valueFieldOrder };
}

/** Reads the worksheet's flat summary data, returning an array of plain `{fieldName: value}`
 *  rows. Uses the classic (non-paginated) API rather than getSummaryDataReaderAsync — the
 *  latter's row-count metadata triggers a protocol mismatch on some Tableau Desktop versions. */
async function getSummaryDataTable(worksheet) {
  const summary = await worksheet.getSummaryDataAsync({ ignoreSelection: true, maxRows: 0 });
  return summary.data.map((row) => {
    const obj = {};
    summary.columns.forEach((col, i) => {
      const cell = row[i];
      const isNumeric = col.dataType === 'int' || col.dataType === 'float';
      // Preserve null/undefined as-is (rather than coercing to 0) so leaf-level cells can
      // still show a configurable null placeholder; aggregation elsewhere treats null as 0.
      obj[col.fieldName] = isNumeric
        ? (cell.value === null || cell.value === undefined ? null : Number(cell.value))
        : cell.formattedValue;
    });
    return obj;
  });
}

function ensureFieldSettingsDefaults() {
  state.hierarchyFieldNames.forEach((name) => {
    if (!state.fieldSettings[name]) {
      state.fieldSettings[name] = { alias: name, filter: true };
    }
  });

  // Measures and detail (ungrouped) fields share the exact same per-field settings shape
  // (alias/visible/order/format) — they only differ in how their value is computed (see
  // aggregateMeasures vs. the plain per-record value used for details in buildTree).
  //
  // `order` tracks live Marks-card shelf position by default, EVERY time this runs — not just
  // the first time a field is seen — so it stays in sync with the shelf as fields are added.
  // Only an actual drag-reorder (in the grid or the dialog's order list) flips a field to
  // `orderManuallySet`, freezing its position from then on. state.valueFieldOrder is measures+
  // details in Tableau's REAL reported shelf order (see getEncodingMap), not an assumed one.
  state.valueFieldOrder.forEach((name, i) => {
    if (!state.fieldSettings[name]) {
      state.fieldSettings[name] = {
        alias: name,
        filter: true,
        visible: true,
        order: i,
        orderManuallySet: false,
        format: { ...DEFAULT_FORMAT },
      };
    } else {
      // Backfill fields added after settings were first saved, so older saved configs upgrade cleanly.
      const s = state.fieldSettings[name];
      if (s.visible === undefined) s.visible = true;
      if (s.orderManuallySet === undefined) s.orderManuallySet = false;
      if (!s.orderManuallySet) s.order = i;
      if (!s.format) {
        s.format = { ...DEFAULT_FORMAT };
      } else {
        if (s.format.nullValue === undefined) s.format.nullValue = '';
        if (s.format.titleItalic === undefined) s.format.titleItalic = false;
        if (s.format.valuesItalic === undefined) s.format.valuesItalic = false;
        if (s.format.valuesColor === undefined) s.format.valuesColor = '#000000';
      }
    }
  });

  if (!state.groupColumnTitle && state.hierarchyFieldNames.length > 0) {
    state.groupColumnTitle = getFieldAlias(state.hierarchyFieldNames[0]);
  }
}

function getFieldAlias(name) {
  return state.fieldSettings[name]?.alias || name;
}

function getFieldFilter(name) {
  return !!state.fieldSettings[name]?.filter;
}

function getFieldFormat(name) {
  return state.fieldSettings[name]?.format || DEFAULT_FORMAT;
}

/** Renders a numeric value per a field's format config. `type: 'default'` just uses a fixed
 *  en-US style (comma thousands, period decimals) — deliberately not the browser/OS locale,
 *  since that default is what was rendering periods as thousands separators for this user.
 *  Null/undefined (a genuinely empty leaf-level cell) renders as the configured placeholder. */
function formatValue(value, format) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return (format && format.nullValue) || '';
  }
  if (typeof value !== 'number') return value;
  if (!format || format.type === 'default') return value.toLocaleString('en-US');

  const isPercent = format.type === 'percent';
  const num = isPercent ? value * 100 : value;
  const decimals = Number.isInteger(format.decimals) ? format.decimals : 0;
  const sign = num < 0 ? '-' : '';
  let [intPart, decPart] = Math.abs(num).toFixed(decimals).split('.');

  if (format.thousandsSeparator) {
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  let result = sign + (decPart ? `${intPart}.${decPart}` : intPart);
  if (format.prefix) result = format.prefix + result;
  if (format.suffix) result += format.suffix;
  else if (isPercent) result += '%';
  return result;
}

// ============================================================================
// Settings dialog (aliases, inline filters, totals/subtotals, autosize)
//
// Opened via the "Format Extension" button on the Marks card. Dialogs are a separate browser
// context, so state only moves in/out via the payload passed to displayDialogAsync and the
// payload the dialog returns through closeDialog().
// ============================================================================

function openConfigureDialog() {
  ensureFieldSettingsDefaults();
  const openPayload = JSON.stringify({
    fieldSettings: state.fieldSettings,
    totals: state.totals,
    groupColumnTitle: state.groupColumnTitle,
    groupColumnTitleItalic: state.groupColumnTitleItalic,
    groupColumnValuesItalic: state.groupColumnValuesItalic,
    groupColumnValuesColor: state.groupColumnValuesColor,
    defaultExpandLevel: state.defaultExpandLevel,
    defaultSortField: state.defaultSortField,
    defaultSortDir: state.defaultSortDir,
    filtersAlwaysVisible: state.filtersAlwaysVisible,
    hierarchyFieldNames: state.hierarchyFieldNames,
    measureFieldNames: state.measureFieldNames,
    detailFieldNames: state.detailFieldNames,
  });

  tableau.extensions.ui.displayDialogAsync('settings-dialog.html', openPayload, { height: 700, width: 820 })
    .then(async (closePayloadStr) => {
      const result = JSON.parse(closePayloadStr);
      if (result.action === 'cancel') return;

      state.fieldSettings = result.fieldSettings;
      state.totals = result.totals;
      state.groupColumnTitle = result.groupColumnTitle;
      state.groupColumnTitleItalic = result.groupColumnTitleItalic;
      state.groupColumnValuesItalic = result.groupColumnValuesItalic;
      state.groupColumnValuesColor = result.groupColumnValuesColor;
      state.defaultExpandLevel = Number.isInteger(result.defaultExpandLevel) ? result.defaultExpandLevel : 0;
      state.defaultSortField = result.defaultSortField || '_label';
      state.defaultSortDir = result.defaultSortDir === 'desc' ? 'desc' : 'asc';
      state.filtersAlwaysVisible = result.filtersAlwaysVisible !== false;
      await persistSettings();
      rebuildTable();

      if (result.action === 'autosize') autosizeAllColumns();
    })
    .catch(() => { /* user closed the dialog via its native close button — no-op */ });
}

// ============================================================================
// Flat rows -> nested tree
// ============================================================================

/** Sums each measure across a set of flat leaf rows. This is the extension's aggregation rule
 *  for group/subtotal/grand-total values: every parent shows the SUM of its descendants. */
function aggregateMeasures(rows, measureFields) {
  const totals = {};
  measureFields.forEach((m) => {
    totals[m.name] = rows.reduce((sum, r) => sum + (Number(r[m.name]) || 0), 0);
  });
  return totals;
}

/**
 * Recursively groups `rows` by each hierarchy field in order, producing Tabulator's dataTree
 * shape: every group node carries `_children` (its nested groups or leaf rows) plus the
 * aggregated measure totals for everything beneath it.
 *
 * `_label` is a synthetic field shared by every depth so a single "Grouping" column in the grid
 * can display whichever dimension applies at that row's level (Franchise at depth 0, Movie at
 * depth 1, etc). `_children`/`_displayCount` are only attached when there's actually something
 * to expand into — a deepest-level group backed by exactly one underlying record has nothing to
 * differentiate (its own totals already equal that record's), so it's left as a plain terminal
 * row instead of an expand arrow that reveals one blank, redundant-looking line.
 */
function buildTree(rows, hierarchyFields, measureFields, totalsCfg, depth = 0) {
  if (depth >= hierarchyFields.length) {
    // Leaf level: return the raw records themselves, blank tree-column label.
    return rows.map((r) => ({ ...r, _id: nextId(), _label: '', _isLeaf: true, _depth: depth }));
  }

  const field = hierarchyFields[depth];
  const isLastLevel = depth === hierarchyFields.length - 1;
  const groups = new Map();
  rows.forEach((r) => {
    const key = r[field.name] === undefined || r[field.name] === '' ? '(blank)' : r[field.name];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });

  const nodes = [];
  groups.forEach((groupRows, key) => {
    const aggregates = aggregateMeasures(groupRows, measureFields);
    const node = { _id: nextId(), _isGroup: true, _label: key, _depth: depth, ...aggregates };

    const hasNothingToExpandInto = isLastLevel && groupRows.length <= 1;
    if (!hasNothingToExpandInto) {
      const children = buildTree(groupRows, hierarchyFields, measureFields, totalsCfg, depth + 1);
      node._displayCount = children.length;

      let finalChildren = children;
      if (totalsCfg.subtotal.enabled && children.length > 0) {
        const subtotalRow = { _id: nextId(), _isSubtotal: true, _label: 'Subtotal', ...aggregates };
        finalChildren = totalsCfg.subtotal.position === 'top' ? [subtotalRow, ...children] : [...children, subtotalRow];
      }
      node._children = finalChildren;
    }

    nodes.push(node);
  });

  return nodes;
}

function buildRootWithGrandTotal(treeData, flatRows, measureFields, totalsCfg) {
  if (!totalsCfg.grandTotal.enabled) return treeData;
  const grandAggregates = aggregateMeasures(flatRows, measureFields);
  // No `_children` key at all (not even an empty array) — Tabulator shows the expand toggle
  // whenever the key is present, regardless of whether it's empty.
  const grandRow = { _id: 'grand_total', _isGrandTotal: true, _label: 'Grand Total', ...grandAggregates };
  return totalsCfg.grandTotal.position === 'top' ? [grandRow, ...treeData] : [...treeData, grandRow];
}

// ============================================================================
// Tabulator column definitions
// ============================================================================

/** True if `rowData._label` matches `searchTerm`, or any of its descendants' `_label` does
 *  (recursively) — see the comment on the tree column's `headerFilterFunc` for why. */
function labelMatchesDeep(rowData, searchTerm) {
  if (!searchTerm) return true;
  const term = searchTerm.toString().toLowerCase();
  const ownLabel = (rowData._label || '').toString().toLowerCase();
  if (ownLabel.includes(term)) return true;
  return (rowData._children || []).some((child) => labelMatchesDeep(child, searchTerm));
}

/** Ascending comparator that works for both the string-valued tree/detail columns and the
 *  numeric measure columns without needing to know which kind a field is. */
function smartCompare(av, bv) {
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return (av ?? '').toString().localeCompare((bv ?? '').toString());
}

/**
 * Sorts a row-object array (root-level rows, or a group's `_children`) by `sortField`/`dir`,
 * recursing into every nested `_children` array — while pulling the subtotal/grand-total row
 * (if present) out before sorting and re-inserting it at its configured top/bottom position
 * afterward, so it never gets shuffled in among the rows it's summarizing. This is the ONLY
 * function that ever decides row order — both the initial render and every interactive
 * header-click sort (see handleInteractiveSort) route through it, rather than letting Tabulator's
 * own sort run and trying to patch up its result afterward.
 */
function sortRowsPreservingPins(rows, sortField, dir, isRoot) {
  const pinnedIndex = rows.findIndex((r) => (isRoot ? r._isGrandTotal : r._isSubtotal));
  const pinnedRow = pinnedIndex >= 0 ? rows[pinnedIndex] : null;
  const normalRows = pinnedIndex >= 0 ? rows.filter((_, i) => i !== pinnedIndex) : rows.slice();

  normalRows.sort((a, b) => {
    const result = smartCompare(a[sortField], b[sortField]);
    return dir === 'desc' ? -result : result;
  });

  normalRows.forEach((r) => {
    if (r._children) r._children = sortRowsPreservingPins(r._children, sortField, dir, false);
  });

  if (!pinnedRow) return normalRows;
  const position = isRoot ? state.totals.grandTotal.position : state.totals.subtotal.position;
  return position === 'top' ? [pinnedRow, ...normalRows] : [...normalRows, pinnedRow];
}

/**
 * Keeping subtotal/grand-total rows pinned by letting Tabulator apply its own sort and then
 * physically moving the pinned rows afterward (via row.move()) turned out to be unreliable in
 * practice across repeated attempts — it depends on exactly how Tabulator's own sort direction
 * gets applied internally, which isn't something to build reliable behavior on top of.
 *
 * Instead, Tabulator's header click is used purely as an input signal ("the user wants column X
 * sorted direction Y") — sortRowsPreservingPins() (the same function that already produces a
 * correctly pinned FIRST render, below) is the only code that ever decides row order. Every
 * interactive header click just updates state.defaultSortField/Dir and triggers a full
 * rebuildTable(), which re-derives the tree from state.lastFlatRows and re-sorts it the same
 * trusted way every time — so there is exactly one sorting code path instead of two that can
 * disagree with each other.
 */
let handlingInteractiveSort = false;
function handleInteractiveSort(sorters) {
  if (handlingInteractiveSort) return;
  const sorter = sorters && sorters[0];
  if (!sorter) return;
  // Always rebuilds, even if sorter.field/dir already match state.defaultSortField/Dir — e.g. the
  // very first click on a column that happens to match the persisted default: Tabulator's own
  // sort has already run once (ignoring pinning) by the time this fires, so skipping the rebuild
  // here just because the field/dir "looks unchanged" would leave that wrong pass on screen.

  state.defaultSortField = sorter.field;
  state.defaultSortDir = sorter.dir;
  persistSettings();
  handlingInteractiveSort = true;
  // Deferred: this fires from inside Tabulator's own dataSorted dispatch, which is still
  // mid-way through applying its (unpinned) sort — tearing the table down synchronously here
  // would do that while Tabulator is still on the call stack that triggered it.
  setTimeout(() => {
    handlingInteractiveSort = false;
    rebuildTable();
  }, 0);
}

function buildColumnDefs(hierarchyFields, valueFields, groupColumnTitle, groupColumnTitleItalic, groupColumnValuesItalic, groupColumnValuesColor, showTreeColumn, groupColumnWidth) {
  // The tree column shows whichever hierarchy field applies at a row's depth (see buildTree's
  // `_label`), so its inline filter is gated on whether ANY hierarchy field asked for one.
  const treeColumnFilterEnabled = hierarchyFields.some((f) => f.filter);

  const treeColumn = {
    title: groupColumnTitleItalic ? `<i>${groupColumnTitle}</i>` : groupColumnTitle,
    field: '_label',
    frozen: true, // pinned to the left by default; user can unpin via the header context menu
    headerSort: true,
    sorter: 'string',
    resizable: true,
    // A persisted manual width overrides fitDataFill's auto-sizing for just this column;
    // omitted (undefined) lets it auto-fit as before until the user resizes it once.
    ...(groupColumnWidth ? { width: groupColumnWidth } : {}),
    headerFilter: treeColumnFilterEnabled ? 'input' : false,
    // Tabulator's default tree filtering tests each row against its OWN value only, and prunes
    // a whole branch the moment an ancestor fails — so searching a value that only exists
    // several levels down (e.g. a launch name under Franchise > Company) matched nothing. This
    // custom filter instead asks "does this row OR any of its descendants match?", so every
    // ancestor on the path to a deep match still passes.
    headerFilterFunc: (searchTerm, rowValue, rowData) => labelMatchesDeep(rowData, searchTerm),
    headerContextMenu: treeColumnContextMenu,
    // Lets the user hover a group value to see which hierarchy field/level it represents,
    // since all levels share this one merged column.
    tooltip: (e, cell) => {
      const data = cell.getData();
      return data._isGroup ? (hierarchyFields[data._depth]?.alias || '') : '';
    },
    formatter: (cell) => {
      const data = cell.getData();
      const value = cell.getValue();
      let content;
      if (data._isGrandTotal || data._isSubtotal) content = `<strong>${value}</strong>`;
      // Only groups with an actual expand arrow (see buildTree) show a "(n)" count.
      else if (data._isGroup && data._children) content = `${value} (${data._displayCount})`;
      else content = value;
      if (groupColumnValuesItalic) content = `<i>${content}</i>`;
      const color = groupColumnValuesColor || '#000000';
      return `<span style="color:${color}">${content}</span>`;
    },
  };

  // Measures (aggregated, numeric) and details (per-record, not grouped) render the same way —
  // formatValue() already passes non-numeric values through untouched — they only differ in
  // sort type/alignment and in how buildTree populates their value.
  const valueColumns = valueFields.map((m) => ({
    title: m.format.titleItalic ? `<i>${m.alias}</i>` : m.alias,
    field: m.name,
    sorter: m.kind === 'measure' ? 'number' : 'string',
    hozAlign: m.kind === 'measure' ? 'right' : 'left',
    resizable: true,
    ...(m.width ? { width: m.width } : {}),
    headerFilter: m.filter ? 'input' : false,
    headerContextMenu: valueColumnContextMenu,
    formatter: (cell) => {
      let text = formatValue(cell.getValue(), m.format);
      if (m.format.valuesItalic) text = `<i>${text}</i>`;
      const color = m.format.valuesColor || '#000000';
      return `<span style="color:${color}">${text}</span>`;
    },
  }));

  // No hierarchy means nothing to group into rows — the tree column would just be a persistent
  // blank frozen column. Keep it only if it's still doing something (labeling a grand-total row).
  return showTreeColumn ? [treeColumn, ...valueColumns] : valueColumns;
}

/** Right-click menu shared by every header: per-column autosize and pin/unpin (freeze) toggle. */
const baseColumnContextMenu = [
  {
    label: 'Autosize this column',
    action: (e, column) => column.setWidth(true),
  },
  {
    label: (column) => (column.getDefinition().frozen ? 'Unpin column' : 'Pin column (freeze left)'),
    action: (e, column) => column.updateDefinition({ frozen: !column.getDefinition().frozen }),
  },
  {
    label: 'Expand all groups',
    action: () => { if (state.table) expandAllTreeRows(state.table.getRows()); },
  },
  {
    label: 'Collapse all groups',
    action: () => { if (state.table) collapseAllTreeRows(state.table.getRows()); },
  },
];

// A hidden column has no header left to right-click, so restoring it can't live on that same
// menu — "Show all columns" is offered on every remaining header instead, as an always-visible
// way back that doesn't depend on remembering to open the Format Extension dialog.
const showAllColumnsItem = {
  label: 'Show all columns',
  action: () => {
    [...state.measureFieldNames, ...state.detailFieldNames].forEach((name) => {
      if (state.fieldSettings[name]) state.fieldSettings[name].visible = true;
    });
    persistSettings();
    rebuildTable();
  },
};

// The group/tree column can't be hidden (it's the one column every level shares), so only
// measure/detail columns get a "Hide column" entry. Hiding here updates the same visible flag
// the settings dialog reads, and persists it, so it stays hidden after the next rebuild/reopen.
const treeColumnContextMenu = [...baseColumnContextMenu, showAllColumnsItem];
const valueColumnContextMenu = [
  ...baseColumnContextMenu,
  {
    label: 'Hide column',
    action: (e, column) => {
      const name = column.getField();
      if (!state.fieldSettings[name]) return;
      state.fieldSettings[name].visible = false;
      persistSettings();
      rebuildTable();
    },
  },
  showAllColumnsItem,
];

// ============================================================================
// Tabulator rendering
// ============================================================================

function rebuildTable() {
  const hierarchyFields = state.hierarchyFieldNames.map((name) => ({ name, alias: getFieldAlias(name), filter: getFieldFilter(name) }));

  // Measures and details are merged into ONE ordered/visibility list — they share the same
  // `order`/`visible` settings (see ensureFieldSettingsDefaults) so a drag-reorder in the grid
  // can freely intermix them, rather than always grouping all details before all measures.
  const buildFieldConfig = (name, kind) => ({
    name,
    kind,
    alias: getFieldAlias(name),
    filter: getFieldFilter(name),
    format: getFieldFormat(name),
    visible: state.fieldSettings[name]?.visible !== false,
    order: state.fieldSettings[name]?.order ?? 0,
    width: state.fieldSettings[name]?.width,
  });
  const valueFields = [
    ...state.measureFieldNames.map((name) => buildFieldConfig(name, 'measure')),
    ...state.detailFieldNames.map((name) => buildFieldConfig(name, 'detail')),
  ]
    .filter((f) => f.visible)
    .sort((a, b) => a.order - b.order);

  // Only measures are actually summed — detail fields ride along on each leaf row as-is (via
  // buildTree's `{...r}` spread) and are simply absent/blank on group/subtotal/grand-total rows.
  const measureFields = valueFields.filter((f) => f.kind === 'measure');

  const treeData = buildTree(state.lastFlatRows, hierarchyFields, measureFields, state.totals);
  const rootData = buildRootWithGrandTotal(treeData, state.lastFlatRows, measureFields, state.totals);
  // Without hierarchy there's nothing to group into rows, so the tree column would just be a
  // persistent, always-blank frozen column — the grand-total row already stands out via its
  // own bold/shaded styling (see rowFormatter), so it doesn't need this column just to label it.
  const showTreeColumn = hierarchyFields.length > 0;
  const columnDefs = buildColumnDefs(
    hierarchyFields, valueFields, state.groupColumnTitle || 'Group',
    state.groupColumnTitleItalic, state.groupColumnValuesItalic, state.groupColumnValuesColor,
    showTreeColumn, state.groupColumnWidth,
  );

  if (state.table) {
    state.table.destroy();
  }

  // Expand the first N hierarchy levels by default (state.defaultExpandLevel), rest collapsed.
  const startExpanded = Array.from(
    { length: Math.max(hierarchyFields.length, 1) },
    (_, i) => i < state.defaultExpandLevel,
  );

  // Pins down a deterministic row order every time the table (re)builds — see the comment on
  // state.defaultSortField. Falls back to the group column (or the first value column, if there
  // is no group column) if the configured sort field isn't actually present this time around
  // (e.g. the field was removed from its shelf).
  const sortableFieldNames = new Set([
    ...(showTreeColumn ? ['_label'] : []),
    ...valueFields.map((f) => f.name),
  ]);
  const sortField = sortableFieldNames.has(state.defaultSortField)
    ? state.defaultSortField
    : (showTreeColumn ? '_label' : valueFields[0]?.name);
  // Sorted here in plain JS, and re-run through this exact same function on every subsequent
  // interactive header-click sort too (see handleInteractiveSort) — a single trusted sorting code
  // path, rather than letting Tabulator's own sort run and trying to patch up its result after.
  const sortedRootData = sortField ? sortRowsPreservingPins(rootData, sortField, state.defaultSortDir, true) : rootData;

  // "Always visible filters" (Format Extension > Fields) shows every configured filter input
  // permanently in a row below the headers via Tabulator's own native header-filter markup — see
  // the .filters-always-visible rule in grid-theme.css — instead of the toggle-icon approach.
  document.getElementById('grid-table').classList.toggle('filters-always-visible', state.filtersAlwaysVisible);

  state.table = new Tabulator('#grid-table', {
    data: sortedRootData,
    layout: 'fitDataFill',
    height: '100%',
    dataTree: true,
    dataTreeChildField: '_children',
    dataTreeStartExpanded: startExpanded,
    columns: columnDefs,
    placeholder: 'No data',
    movableColumns: true, // drag a header to reorder columns directly in the grid
    // Tags each row with a depth/role class (see grid-theme.css) so group rows shade/bold
    // progressively shallower going down the hierarchy, matching the reference design.
    rowFormatter: (row) => {
      const data = row.getData();
      const el = row.getElement();
      if (data._isGrandTotal) el.classList.add('row-grandtotal');
      else if (data._isSubtotal) el.classList.add('row-subtotal');
      else if (data._isGroup) el.classList.add(`row-depth-${data._depth}`);
      else el.classList.add('row-leaf');
    },
    // Tabulator hides tree-data matches inside collapsed branches without expanding them —
    // force everything open while a filter is active so nested matches are actually visible.
    dataFiltered: (filters) => {
      if (filters.length > 0) expandAllTreeRows(state.table.getRows());
    },
    // Persists a drag-reorder in the grid back into the same `order` the settings dialog
    // uses, so it survives the next rebuild instead of reverting.
    columnMoved: () => {
      state.table.getColumns().filter((c) => c.getField() !== '_label').forEach((col, i) => {
        const name = col.getField();
        if (state.fieldSettings[name]) {
          state.fieldSettings[name].order = i;
          state.fieldSettings[name].orderManuallySet = true;
        }
      });
      persistSettings();
    },
    // Persists a manual resize (drag or the "Autosize" actions, which also fire this) so the
    // width survives the next rebuild instead of fitDataFill recalculating it from scratch.
    columnResized: (column) => {
      const field = column.getField();
      const width = column.getWidth();
      if (field === '_label') state.groupColumnWidth = width;
      else if (state.fieldSettings[field]) state.fieldSettings[field].width = width;
      persistSettings();
    },
    // Header-rename and filter-toggle attachment have to wait for this event: table construction
    // is asynchronous, so calling col.getElement() right after `new Tabulator(...)` returns can
    // hit a DOM that isn't there yet, silently no-op'ing the button/handler attachment.
    tableBuilt: () => {
      document.getElementById('grid-table').classList.toggle('filters-always-visible', state.filtersAlwaysVisible);
      attachHeaderRenameHandlers();
      if (!state.filtersAlwaysVisible) attachFilterToggleButtons();
    },
    // Every interactive header-click sort is re-routed through handleInteractiveSort, which
    // rebuilds the table via the exact same sortRowsPreservingPins() call used for the initial
    // render, instead of trying to patch up Tabulator's own sort result afterward.
    dataSorted: (sorters) => handleInteractiveSort(sorters),
  });
}

/** Double-click any header (group column or measure) to rename it directly in the grid,
 *  mirroring the alias/group-title fields in the Format Extension dialog. */
function attachHeaderRenameHandlers() {
  state.table.getColumns().forEach((col) => {
    const titleEl = col.getElement().querySelector('.tabulator-col-title');
    if (!titleEl) return;
    titleEl.style.cursor = 'text';
    titleEl.addEventListener('dblclick', () => {
      const field = col.getField();
      const current = field === '_label' ? (state.groupColumnTitle || 'Group') : getFieldAlias(field);
      const next = window.prompt('Column name:', current);
      if (next === null || next.trim() === '') return;

      if (field === '_label') {
        state.groupColumnTitle = next.trim();
      } else if (state.fieldSettings[field]) {
        state.fieldSettings[field].alias = next.trim();
      }
      persistSettings();
      rebuildTable();
    });
  });
}

/** Adds a small toggle icon next to the title of every column that has an inline filter
 *  enabled, so the filter input stays hidden (see grid-theme.css) until the user asks for it —
 *  rather than every configured filter always showing an input row, cluttering the header. */
function attachFilterToggleButtons() {
  state.table.getColumns().forEach((col) => {
    const def = col.getDefinition();
    if (!def.headerFilter) return;

    const colEl = col.getElement();
    const titleHolder = colEl.querySelector('.tabulator-col-title-holder') || colEl.querySelector('.tabulator-col-title');
    if (!titleHolder || titleHolder.querySelector('.filter-toggle-btn')) return;

    const btn = document.createElement('span');
    btn.className = 'filter-toggle-btn';
    btn.textContent = '🔍';
    btn.title = 'Toggle inline filter';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = colEl.classList.toggle('filter-open');
      btn.classList.toggle('active', open);
      if (open) {
        const input = colEl.querySelector('.tabulator-header-filter input');
        if (input) input.focus();
      }
    });
    titleHolder.appendChild(btn);
  });
}

function expandAllTreeRows(rows) {
  rows.forEach((row) => {
    const children = row.getTreeChildren ? row.getTreeChildren() : [];
    if (children.length > 0) {
      row.treeExpand();
      expandAllTreeRows(children);
    }
  });
}

function collapseAllTreeRows(rows) {
  rows.forEach((row) => {
    const children = row.getTreeChildren ? row.getTreeChildren() : [];
    if (children.length > 0) {
      collapseAllTreeRows(children);
      row.treeCollapse();
    }
  });
}

function autosizeAllColumns() {
  if (!state.table) return;
  state.table.getColumns().forEach((col) => col.setWidth(true));
}
