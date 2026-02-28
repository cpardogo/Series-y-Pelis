// modules/ui_filters.js

function uniqSorted(arr) {
  return Array.from(new Set(arr.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function buildFilterOptions(items) {
  const platforms = [];
  const genres = [];

  for (const it of items) {
    for (const p of (it.platforms ?? [])) platforms.push(p);
    for (const g of (it.genres ?? [])) genres.push(g);
  }

  return {
    platforms: uniqSorted(platforms),
    genres: uniqSorted(genres),
  };
}

/**
 * Renderiza chips y devuelve un pequeño controlador de estado.
 * @param {HTMLElement} mountEl
 * @param {Object} options
 * @param {string[]} options.platforms
 * @param {string[]} options.genres
 * @param {(state: any) => void} onChange
 */
export function mountFilters(mountEl, options, onChange) {
  const state = { platformsSelected: [], genresSelected: [] };

  mountEl.innerHTML = `
    <div class="filters">
      <div class="filters__row">
        <div class="filters__label">Plataformas</div>
        <div class="filters__chips" data-group="platform">
          ${options.platforms.map(p => `<button class="chip" data-value="${esc(p)}" type="button">${esc(p)}</button>`).join("")}
        </div>
      </div>

      <div class="filters__row">
        <div class="filters__label">Géneros</div>
        <div class="filters__chips" data-group="genre">
          ${options.genres.map(g => `<button class="chip" data-value="${esc(g)}" type="button">${esc(g)}</button>`).join("")}
        </div>
      </div>

      <div class="filters__actions">
        <button class="btn-clear" type="button">Limpiar</button>
      </div>
    </div>
  `;

  function toggle(group, value) {
    const key = group === "platform" ? "platformsSelected" : "genresSelected";
    const arr = state[key];
    const idx = arr.indexOf(value);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(value);
  }

  function syncUI() {
    mountEl.querySelectorAll(".chip").forEach((btn) => {
      const group = btn.closest("[data-group]")?.getAttribute("data-group");
      const value = btn.getAttribute("data-value");
      const key = group === "platform" ? "platformsSelected" : "genresSelected";
      btn.classList.toggle("chip--on", state[key].includes(value));
    });
  }

  mountEl.addEventListener("click", (e) => {
    const t = e.target;

    if (t.classList?.contains("chip")) {
      const group = t.closest("[data-group]")?.getAttribute("data-group");
      const value = t.getAttribute("data-value");
      toggle(group, value);
      syncUI();
      onChange({ ...state });
    }

    if (t.classList?.contains("btn-clear")) {
      state.platformsSelected = [];
      state.genresSelected = [];
      syncUI();
      onChange({ ...state });
    }
  });

  syncUI();
  onChange({ ...state });

  return { getState: () => ({ ...state }) };
}

/**
 * CSS mínimo (cópialo a tu CSS principal)
 */
export const FILTERS_CSS = `
.filters{display:flex;flex-direction:column;gap:12px;margin:12px 0}
.filters__row{display:flex;flex-direction:column;gap:8px}
.filters__label{font-size:12px;opacity:.85}
.filters__chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;
      padding:6px 10px;border-radius:999px;font-size:12px;cursor:pointer}
.chip--on{border-color:rgba(255,255,255,.45);background:rgba(255,255,255,.08)}
.filters__actions{display:flex;gap:10px}
.btn-clear{border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;
          padding:6px 10px;border-radius:10px;font-size:12px;cursor:pointer}
`;
