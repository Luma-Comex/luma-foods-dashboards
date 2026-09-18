// Genera el dashboard de embarques de SIPIA a partir de datos frescos de Salesforce.
// Uso: node generar_sipia_dashboard.js
// Requiere: sf CLI autenticado como comex@lateamfoods.com

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ACCOUNT_ID = '001Dn00000HJgD6IAL'; // SIPIA
const OUT_FILE = path.join(__dirname, '..', 'sipia', 'index.html');

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// Etiquetas en espanol para el cliente (en Salesforce estan en ingles y con typos)
const STATUS_LABEL = {
  'In Approval Process': 'En curso',
  'Waiting for sign': 'Pendiente de firma',
  'Parcial Loaded': 'Parcialmente cargado',
};
const STATUS_CLASS = {
  'In Approval Process': 'st-info',
  'Waiting for sign': 'st-neutral',
  'Parcial Loaded': 'st-warning',
};

const PRODUCT_ICON = {
  'Sweet Corn': '🌽',
  'Frozen Sweet Corn': '🌽',
  'Baby Gherkins': '🥒',
};

function runSOQL(query) {
  const flat = query.replace(/\s+/g, ' ').trim().replace(/"/g, '\\"');
  const cmd = `sf data query --query "${flat}" --target-org comex@lateamfoods.com --json`;
  const out = execSync(cmd, { maxBuffer: 20 * 1024 * 1024 }).toString();
  const parsed = JSON.parse(out);
  return parsed.result.records;
}

const ESTADOS_ACTIVOS = "'In Approval Process','Waiting for sign','Parcial Loaded'";
// "Finalizados" = todo lo que ya no esta en curso. Incluye Loaded por decision del usuario.
const ESTADOS_HISTORICOS = "'Completed','Loaded'";

function fetchContracts() {
  return runSOQL(`
    SELECT ContractNumber, Nro_Proforma__c, Status, StartDate, EndDate, Incoterm__c,
     Puerto_origen__c, Puerto_Destino__c, Total_Value__c,
     Packing_Material_Status__c, Approved_Packing_Materials__c, Packing_Material_Records__c,
     (SELECT Name, Principal_Product__c, Unit_Price__c, Quantity__c, Loaded__c, Unloaded__c, Subtotal__c FROM Contratct_Products__r),
     (SELECT Name, Confirmed__c, Approval_Date__c, Draft_Files_Sent__c, Days_From_Draft_Sent__c FROM Packing_Materials__r),
     (SELECT Name, Nro_Booking__c, Barco__c, ETD__c, ETD_Updated__c, ETA__c, Destination_Port__c, Status__c,
       Link_BL__c, Tracking_Page__c, Container_N__c, Nro_BL__c, Date_of_approval__c, Deliver__c, Delivery_Date__c,
       Paid__c, Amount_to_be_paid__c, Invoice_payment_date__c
      FROM Shippings__r)
    FROM Contract
    WHERE Account.Id = '${ACCOUNT_ID}' AND Status IN (${ESTADOS_ACTIVOS})
    ORDER BY Total_Value__c DESC
  `);
}

function fetchHistoricos() {
  return runSOQL(`
    SELECT ContractNumber, Nro_Proforma__c, Status, StartDate, EndDate, Incoterm__c,
     Puerto_origen__c, Puerto_Destino__c, Total_Value__c,
     (SELECT Principal_Product__c, Quantity__c, Loaded__c FROM Contratct_Products__r),
     (SELECT Name, ETD_Updated__c, ETA__c, Barco__c, Container_N__c, Status__c FROM Shippings__r)
    FROM Contract
    WHERE Account.Id = '${ACCOUNT_ID}' AND Status IN (${ESTADOS_HISTORICOS})
    ORDER BY EndDate DESC NULLS LAST
  `);
}

// ---------- helpers ----------

function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(s, refYear) {
  const d = parseDate(s);
  if (!d) return null;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = MESES[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return year === refYear ? `${day} ${mon}` : `${day} ${mon} ${year}`;
}

function fmtDateFull(s) {
  const d = parseDate(s);
  if (!d) return null;
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function money(n) {
  return 'US$ ' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function moneyDec(n) {
  return 'US$ ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n) {
  return Math.round(n) + '%';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function productIcon(name) {
  return PRODUCT_ICON[name] || '📦';
}

// Los nombres en Salesforce vienen con dobles espacios y guiones sueltos
// (ej: "Frozen Sweet Corn  20 KG     --Bags (20 KG)"). Esto los deja presentables.
function cleanProductName(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s*-{2,}\s*/g, ' — ')   // "--Bags"  ->  " — Bags"
    .replace(/\s*-\s*(Tins|Bags|Drums|Cans|Box|Boxes)\b/gi, ' — $1') // "Lid-Tins" -> "Lid — Tins"
    .replace(/OZ\b/g, 'oz')
    .replace(/KG\b/g, 'kg')
    .replace(/(\d)\s*-\s*(\d)/g, '$1-$2')  // "3.0 -5.5" -> "3.0-5.5"
    .replace(/:\s*(\d)/g, ': $1')          // "L:3.0" -> "L: 3.0"
    .replace(/\s{2,}/g, ' ')               // colapsar espacios repetidos
    .replace(/\s+([,;:)])/g, '$1')         // espacio antes de puntuacion
    .replace(/\(\s+/g, '(')
    .trim();
}

// Las notas de embarque son apuntes internos de comex, no lenguaje para el cliente.
// Ej: "S4/4/7// ETD: END SEP// Produccion 2026// 12 OZ" -> "Produccion 2026 · 12 oz"
const NOTA_INTERNA = /^(ETD\b|Booking\b|CAJA\b|Sujeto a necesidad)/i;

function cleanShipNote(raw) {
  if (!raw) return '';
  const segmentos = String(raw)
    .split('//')
    .slice(1)                                   // sacar el codigo "S4/4/7"
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !NOTA_INTERNA.test(s))         // sacar "ETD: END SEP", "Booking OK", "CAJA OK"
    .map(s => s.replace(/\(\s*IF NEEDED\s*\)/ig, '').trim())
    .filter(Boolean)
    .map(s => {
      // "FROZEN CORN" -> "Frozen Corn"; deja en paz textos que ya son mixtos
      if (s === s.toUpperCase() && /[A-Z]{3,}/.test(s)) s = toTitleCase(s);
      return s
        .replace(/\bProduccion\b/gi, 'Producción')
        .replace(/\bOZ\b/gi, 'oz')
        .replace(/\bKG\b/gi, 'kg');
    })
    .filter(Boolean);
  return segmentos.join(' · ');
}

// status rank for sorting: ongoing first, then tbi, then loaded
const STATUS_RANK = { 'On going': 0, 'TBI': 1, 'Loaded': 2 };

function statusPillClass(s) {
  if (s === 'Loaded') return { cls: 'st-good', label: 'Cargado' };
  if (s === 'On going') return { cls: 'st-warning', label: 'En curso' };
  return { cls: 'st-neutral', label: 'Por definir' };
}

function filterKey(s) {
  if (s === 'Loaded') return 'loaded';
  if (s === 'On going') return 'ongoing';
  return 'tbi';
}

// ---------- render pieces ----------

function renderProductRow(p) {
  const loaded = p.Loaded__c || 0;
  const qty = p.Quantity__c || 0;
  const loadedPct = qty > 0 ? (loaded / qty) * 100 : 0;
  return `
                <tr data-subtotal="${p.Subtotal__c}" data-pct="${Math.round(loadedPct)}">
                  <td class="product-name"><span class="cat-icon" aria-hidden="true">${productIcon(p.Principal_Product__c)}</span>${esc(cleanProductName(p.Name))} <span class="principal">${esc(p.Principal_Product__c)}</span></td>
                  <td class="num">${moneyDec(p.Unit_Price__c)}</td>
                  <td class="num">${qty.toLocaleString('en-US')}</td>
                  <td class="num">${money(p.Subtotal__c)}</td>
                  <td class="num">
                    <div class="prod-progress"><div class="track"><div class="fill" style="width:${Math.round(loadedPct)}%"></div></div><span class="pct">${pct(loadedPct)}</span></div>
                  </td>
                </tr>`;
}

function delayInfo(etdReq, etdUpd) {
  if (!etdReq || !etdUpd) return null;
  const days = daysBetween(parseDate(etdReq), parseDate(etdUpd));
  return { days, delayed: days > 15 };
}

function renderDelayFlag(delay) {
  if (!delay || !delay.delayed) return '';
  return `<span class="delay-flag">⚠ Delayed Shipping · +${delay.days} días</span>`;
}

function renderTrackingCell(linkBL) {
  if (linkBL && /^https?:\/\//i.test(linkBL)) {
    return `<a class="track-btn" href="${esc(linkBL)}" target="_blank" rel="noopener">Ver tracking en vivo ↗</a>`;
  }
  if (linkBL) {
    return `<span class="track-muted">Naviera: ${esc(linkBL.toUpperCase())} · sin link directo</span>`;
  }
  return `<span class="track-muted">Sin booking aún</span>`;
}

function renderDocsPanel(s) {
  const aprobado = s.Date_of_approval__c
    ? `<b class="pay-ok">Sí</b> · ${fmtDate(s.Date_of_approval__c, REF_YEAR)}`
    : `<b class="pay-pending">No</b>`;
  let deliver;
  if (s.Deliver__c === 'Yes') {
    const dhl = s.Tracking_Page__c ? ` <a href="${esc(s.Tracking_Page__c)}" target="_blank" rel="noopener">Ver DHL ↗</a>` : '';
    deliver = `<b class="pay-ok">Sí</b> · ${fmtDate(s.Delivery_Date__c, REF_YEAR)}${dhl}`;
  } else {
    deliver = `<b class="pay-pending">No</b>`;
  }
  let factura;
  if (s.Paid__c === 'Yes') {
    factura = `<b class="pay-ok">Sí</b> · ${money(s.Amount_to_be_paid__c)}${s.Invoice_payment_date__c ? ' · ' + fmtDate(s.Invoice_payment_date__c, REF_YEAR) : ''}`;
  } else if (s.Amount_to_be_paid__c) {
    factura = `<b class="pay-pending">No</b> · ${money(s.Amount_to_be_paid__c)} pendiente`;
  } else {
    factura = `<b class="pay-pending">No</b> (sin emitir aún)`;
  }
  return `
            <div class="ship-docs-panel">
              <div class="ship-docs-panel-inner">
                <span class="docs-label">Documentos de embarque</span>
                <span class="pay-line">Aprobado: ${aprobado}</span>
                <span class="pay-line">Deliver: ${deliver}</span>
                <span class="pay-line">Factura pagada: ${factura}</span>
              </div>
            </div>`;
}

// El campo Name de Shippings__c es, en Salesforce, el numero de factura ("Invoice").
function shipAlert(s) {
  const alerts = [];
  if (s.Status__c !== 'Loaded') return alerts;

  if (!s.Date_of_approval__c) {
    const buque = s.Barco__c ? toTitleCase(s.Barco__c.replace(/\s+(?:voy\.?|v\.)\s*/i, ' · Voy. ')) : null;
    alerts.push({
      type: 'doc',
      id: shipDomId(s),
      text: `Embarque <b>${esc(s.Name)}</b>${buque ? ` · ${esc(buque)}` : ''}`,
    });
  }

  if (s.Paid__c !== 'Yes' && s.Amount_to_be_paid__c) {
    alerts.push({
      type: 'invoice',
      id: shipDomId(s),
      amount: s.Amount_to_be_paid__c,
      text: `Factura <b>${esc(s.Name)}</b> — <b>${money(s.Amount_to_be_paid__c)}</b>`,
    });
  }
  return alerts;
}

function shipDomId(s) {
  return 'ship-' + s.Name.replace(/[^A-Za-z0-9]/g, '');
}

// Bloque de fechas: SIEMPRE muestra ETD y ETA explicitos, en todos los embarques.
function renderFechas(s) {
  const delay = delayInfo(s.ETD__c, s.ETD_Updated__c);
  const etd = s.ETD_Updated__c ? fmtDate(s.ETD_Updated__c, REF_YEAR) : 'por confirmar';
  const eta = s.ETA__c ? fmtDate(s.ETA__c, REF_YEAR) : 'por confirmar';
  const req = delay && delay.delayed
    ? `<div class="etd-required">ETD original ${fmtDate(s.ETD__c, REF_YEAR)}</div>${renderDelayFlag(delay)}`
    : '';
  return `<div class="ship-dates">
                <div class="fecha-linea"><span class="fecha-tag">ETD</span><span class="fecha-val${s.ETD_Updated__c ? '' : ' pendiente'}">${etd}</span></div>
                <div class="fecha-linea"><span class="fecha-tag">ETA</span><span class="fecha-val${s.ETA__c ? '' : ' pendiente'}">${eta}</span></div>
                ${req}
              </div>`;
}

// Barra de ruta con el barquito. Solo para embarques ya cargados y con ETA.
function routeProgressHtml(s, today, origin, dest) {
  const eta = parseDate(s.ETA__c);
  const etdUpd = parseDate(s.ETD_Updated__c);
  if (!eta || !etdUpd) return '';

  if (today.getTime() >= eta.getTime()) {
    const daysSince = daysBetween(eta, today);
    return `
              <div class="route-progress" style="--p:100%">
                <div class="ports"><span class="reached">${esc(origin)}</span><span class="reached">${esc(dest)}</span></div>
                <div class="track"><div class="fill"></div><span class="ship">🚢</span></div>
                <div class="caption">Arribó <b>hace ${daysSince} días</b></div>
              </div>`;
  }
  if (today.getTime() < etdUpd.getTime()) {
    return `
              <div class="route-progress not-departed" style="--p:0%">
                <div class="ports"><span>${esc(origin)}</span><span>${esc(dest)}</span></div>
                <div class="track"><div class="fill"></div><span class="ship">🚢</span></div>
                <div class="caption"><b>Aún no zarpa</b> (estimado)</div>
              </div>`;
  }
  const total = daysBetween(etdUpd, eta) || 1;
  const elapsed = daysBetween(etdUpd, today);
  const p = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
  return `
              <div class="route-progress in-transit" style="--p:${p}%">
                <div class="ports"><span class="reached">${esc(origin)}</span><span>${esc(dest)}</span></div>
                <div class="track"><div class="fill"></div><span class="ship">🚢</span></div>
                <div class="caption">En tránsito · <b>~${p}% del trayecto</b> (estimado)</div>
              </div>`;
}

function renderVesselCell(s) {
  if (!s.Barco__c) return `<div class="ship-vessel"><span class="v-none">Buque aún sin asignar</span></div>`;
  const m = s.Barco__c.match(/^(.*?)\s+(?:voy\.?|v\.)\s*(.+)$/i);
  const name = m ? m[1] : s.Barco__c;
  const voy = m ? m[2] : null;
  return `<div class="ship-vessel"><span class="v-name">${esc(toTitleCase(name))}</span>${voy ? `<span class="ship-note">Voy. ${esc(voy)}</span>` : ''}</div>`;
}

function toTitleCase(s) {
  return s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

// seq / totalSeq: posicion del embarque dentro del contrato, calculada por orden de ETD.
function renderShipmentRow(s, origin, dest, seq, totalSeq) {
  const st = statusPillClass(s.Status__c);
  const id = s.Status__c === 'Loaded' ? ` id="${shipDomId(s)}"` : '';
  const alerts = shipAlert(s);
  const toggleClass = alerts.length ? ' has-alert' : '';
  const toggleAria = alerts.length ? 'Documentación y pagos — atención' : 'Documentación y pagos';

  const placeholderMatch = s.Name.match(/^S(\d+)\/(\d+)\/(\d+)/);
  const label = placeholderMatch ? 'Embarque sin booking' : s.Name;
  const note = (s.Nro_BL__c || s.Container_N__c)
    ? [s.Nro_BL__c ? 'BL ' + s.Nro_BL__c : null, s.Container_N__c ? 'Cont. ' + s.Container_N__c : null].filter(Boolean).join(' · ')
    : (placeholderMatch ? cleanShipNote(s.Name) : '');

  const ruta = (s.Status__c === 'Loaded') ? routeProgressHtml(s, TODAY, origin, dest) : '';
  const trackingCell = s.Status__c === 'Loaded' ? renderTrackingCell(s.Link_BL__c) : renderTrackingCell(null);

  return `
            <div class="shipment-row" data-status="${filterKey(s.Status__c)}"${id}>
              <div class="ship-id-block">
                <span class="ship-id"><span class="seq-badge" title="Embarque ${seq} de ${totalSeq} del contrato">${seq}/${totalSeq}</span>${esc(label)}</span>
                ${note ? `<span class="ship-note">${esc(note)}</span>` : ''}
              </div>
              ${renderVesselCell(s)}
              <span class="status-pill ${st.cls}"><span class="dot"></span>${st.label}</span>
              <div class="ship-fechas">${renderFechas(s)}${ruta}</div>
              ${trackingCell}
              <button class="ship-docs-toggle${toggleClass}" type="button" aria-expanded="false" aria-label="${toggleAria}" title="${toggleAria}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
            </div>${renderDocsPanel(s)}`;
}

// Materiales de empaque: seccion desplegable, cerrada por defecto.
function renderPackingPanel(c) {
  const pms = c.Packing_Materials__r ? c.Packing_Materials__r.records : [];
  const aprobados = c.Approved_Packing_Materials__c || 0;
  const totalPM = c.Packing_Material_Records__c || pms.length;
  const estado = c.Packing_Material_Status__c || 'Sin datos';
  const todoOk = totalPM > 0 && aprobados >= totalPM;
  const estadoEs = estado === 'All Confirmed' ? 'Todos confirmados'
    : estado === 'In process' ? 'En proceso'
    : estado;

  const filas = pms.length ? pms.map(p => {
    const ok = p.Confirmed__c === 'Yes';
    return `                <tr>
                  <td>${esc(cleanProductName(p.Name))}</td>
                  <td><span class="pm-estado ${ok ? 'ok' : 'pend'}">${ok ? '✓ Confirmado' : '○ Pendiente'}</span></td>
                  <td class="num">${p.Draft_Files_Sent__c ? fmtDate(p.Draft_Files_Sent__c, REF_YEAR) : '—'}</td>
                  <td class="num">${p.Approval_Date__c ? fmtDate(p.Approval_Date__c, REF_YEAR) : '—'}</td>
                </tr>`;
  }).join('\n') : `                <tr><td colspan="4" class="pm-vacio">Todavía no hay materiales de empaque cargados para este contrato.</td></tr>`;

  return `
        <div class="docs-toggle-wrap">
          <button class="pack-toggle${todoOk ? '' : ' pendiente'}" type="button" aria-expanded="false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
            <span>Materiales de empaque</span>
            <span class="pack-resumen">${esc(estadoEs)} · ${aprobados} de ${totalPM}</span>
          </button>
          <div class="pack-panel">
            <table class="pack-table">
              <thead><tr><th>Material</th><th>Estado</th><th class="num">Draft enviado</th><th class="num">Aprobado</th></tr></thead>
              <tbody>
${filas}
              </tbody>
            </table>
          </div>
        </div>`;
}

function renderContract(c, idx) {
  const label = STATUS_LABEL[c.Status] || c.Status;
  const cls = STATUS_CLASS[c.Status] || 'st-neutral';
  const products = c.Contratct_Products__r ? c.Contratct_Products__r.records : [];
  const totalQty = products.reduce((a, p) => a + (p.Quantity__c || 0), 0);
  const totalLoaded = products.reduce((a, p) => a + (p.Loaded__c || 0), 0);
  const overallPct = totalQty > 0 ? (totalLoaded / totalQty) * 100 : 0;
  const mainIcon = productIcon(products[0] ? products[0].Principal_Product__c : '');
  const mainProductName = products[0] ? products[0].Principal_Product__c : '';

  const shipments = (c.Shippings__r ? c.Shippings__r.records : []).slice();
  shipments.sort((a, b) => (STATUS_RANK[a.Status__c] ?? 3) - (STATUS_RANK[b.Status__c] ?? 3));
  const total = shipments.length;

  const origin = toTitleCase(c.Puerto_origen__c);
  const dest = toTitleCase(c.Puerto_Destino__c);
  // Numeracion 1/N: la posicion real del embarque sale de ordenarlos por ETD actualizado.
  const porEtd = shipments.slice().sort((a, b) => {
    const da = a.ETD_Updated__c || a.ETD__c || '9999-12-31';
    const db = b.ETD_Updated__c || b.ETD__c || '9999-12-31';
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const seqPorId = new Map(porEtd.map((s, i) => [s.Name, i + 1]));

  const shipmentsHtml = shipments
    .map(s => renderShipmentRow(s, origin, dest, seqPorId.get(s.Name), shipments.length))
    .join('\n');

  const productsHtml = products.map(renderProductRow).join('');

  const dataProducts = [...new Set(products.map(p => (p.Principal_Product__c || '').toLowerCase()))].join(' ');

  return {
    html: `
    <!-- Contract ${esc(c.ContractNumber)} -->
    <article class="contract-card collapsed" data-products="${esc(dataProducts)}" style="--card-accent: var(--${cls === 'st-info' ? 'info' : cls === 'st-warning' ? 'warning' : 'neutral'});">
      <div class="contract-head">
        <div class="head-left">
          <button class="collapse-btn" aria-label="Colapsar contrato" title="Mostrar/ocultar detalle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
          <div class="contract-product"><span class="cat-icon" aria-hidden="true">${mainIcon}</span>${esc(mainProductName)}</div>
        </div>
        <div class="contract-id-block">
          <span class="contract-number">Proforma N.º ${esc(c.Nro_Proforma__c || c.ContractNumber)}</span>
          <div class="route">${esc(origin)} <span class="arrow">→</span> ${esc(dest)}</div>
          <div class="contract-tags">
            <span class="tag incoterm">${esc(c.Incoterm__c)}</span>
            <span class="tag"><b>Inicio:</b> ${fmtDateFull(c.StartDate)}</span>
            <span class="tag"><b>Cierre estimado:</b> ${fmtDateFull(c.EndDate)}</span>
          </div>
        </div>
        <div class="contract-right">
          <span class="status-pill ${cls}"><span class="dot"></span>${esc(label)}</span>
          <div class="contract-value">
            <div class="amount">${money(c.Total_Value__c)}</div>
            <div class="label">Valor total</div>
          </div>
          <div class="contract-progress" title="Avance de carga del contrato">
            <div class="track"><div class="fill" style="width:${Math.round(overallPct)}%"></div></div>
            <span class="pct">${pct(overallPct)}</span>
          </div>
        </div>
      </div>
      <div class="contract-body">
        <div>
          <p class="section-label">Productos</p>
          <div class="overflow-x">
            <table class="products-table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th class="num">Precio unit.</th>
                  <th class="num">Unidades</th>
                  <th class="num sortable" data-sort-key="subtotal">Subtotal <span class="arrow"></span></th>
                  <th class="num sortable" data-sort-key="pct">Cargado <span class="arrow"></span></th>
                </tr>
              </thead>
              <tbody>${productsHtml}
              </tbody>
            </table>
          </div>
        </div>
${renderPackingPanel(c)}
        <div>
          <p class="section-label">Embarques (${total})</p>
          <div class="shipments">${shipmentsHtml}
          </div>
        </div>
      </div>
    </article>`,
    totalValue: c.Total_Value__c,
    shipments,
  };
}

// ---------- main ----------

const contracts = fetchContracts();
const TODAY = new Date();
TODAY.setUTCHours(0, 0, 0, 0);
const REF_YEAR = TODAY.getUTCFullYear();

const rendered = contracts.map(renderContract);
rendered.sort((a, b) => b.totalValue - a.totalValue);

const allShipments = rendered.flatMap(r => r.shipments);
const totalFOB = contracts.reduce((a, c) => a + (c.Total_Value__c || 0), 0);

const statusCounts = { loaded: 0, ongoing: 0, tbi: 0 };
allShipments.forEach(s => statusCounts[filterKey(s.Status__c)]++);
const totalShip = allShipments.length || 1;

const delays = allShipments
  .map(s => delayInfo(s.ETD__c, s.ETD_Updated__c))
  .filter(d => d);
const delayed = delays.filter(d => d.delayed);
const avgDelay = delayed.length ? Math.round(delayed.reduce((a, d) => a + d.days, 0) / delayed.length) : 0;

const alertItems = allShipments.flatMap(shipAlert);
const docAlerts = alertItems.filter(a => a.type === 'doc');
const invoiceAlerts = alertItems.filter(a => a.type === 'invoice');
const invoiceTotal = invoiceAlerts.reduce((a, x) => a + x.amount, 0);

const contractsHtml = rendered.map(r => r.html).join('\n');

const ICON_DOC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg>';
const ICON_MONEY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';

function alertGroup(titulo, items, icono) {
  if (!items.length) return '';
  return `      <p class="alert-group-title">${titulo}</p>
${items.map(a => `      <button class="alert-item" data-jump="${a.id}">
        ${icono}
        <span class="t">${a.text}</span>
      </button>`).join('\n')}`;
}

const alertModalHtml = alertItems.length ? `
<div class="alert-overlay" id="alertOverlay" role="dialog" aria-modal="true" aria-labelledby="alertTitle">
  <div class="alert-modal">
    <div class="alert-modal-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></div>
    <h2 id="alertTitle">Puntos abiertos</h2>
    <p class="lead">Este es el estado de la documentación y los pagos de tus embarques ya cargados. Tocá cualquier ítem para ir directo a su detalle.</p>
    <div class="alert-list">
${alertGroup(`Documentos pendientes de confirmación (${docAlerts.length})`, docAlerts, ICON_DOC)}
${alertGroup(`Facturas pendientes de pago (${invoiceAlerts.length}) · ${money(invoiceTotal)}`, invoiceAlerts, ICON_MONEY)}
    </div>
    <div class="alert-actions">
      <button class="alert-btn" id="alertDismiss" type="button">Entendido, ver el panel</button>
    </div>
  </div>
</div>` : '';

// Fecha Y HORA de la ultima corrida, en hora local de la maquina que genera.
const AHORA = new Date();
const updatedStr = `${String(AHORA.getDate()).padStart(2, '0')} ${MESES[AHORA.getMonth()]} ${AHORA.getFullYear()}, ${String(AHORA.getHours()).padStart(2, '0')}:${String(AHORA.getMinutes()).padStart(2, '0')} hs`;

// ---------- historico de contratos finalizados ----------

const historicos = fetchHistoricos();

// En el historico todo se muestra como "Completado" (pedido del usuario), sin importar
// si en Salesforce figura como Completed o Loaded.
const HIST_LABEL = { 'Completed': 'Completado', 'Loaded': 'Completado' };

const historicoRows = historicos.map((c, i) => {
  const prods = c.Contratct_Products__r ? c.Contratct_Products__r.records : [];
  const ships = c.Shippings__r ? c.Shippings__r.records.slice() : [];
  const nEmb = ships.length;
  const productos = [...new Set(prods.map(p => p.Principal_Product__c).filter(Boolean))];
  const icono = productIcon(productos[0] || '');
  const rowId = 'h' + i;

  ships.sort((a, b) => {
    const da = a.ETD_Updated__c || '9999-12-31', db = b.ETD_Updated__c || '9999-12-31';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const detalle = nEmb ? `
                    <table class="hist-sub">
                      <thead><tr><th>#</th><th>Factura</th><th>Buque</th><th>Contenedor</th><th class="num">ETD</th><th class="num">ETA</th></tr></thead>
                      <tbody>
${ships.map((s, k) => `                        <tr>
                          <td class="mono">${k + 1}/${nEmb}</td>
                          <td class="mono">${/^S\d+\/\d+\/\d+/.test(s.Name) ? '—' : esc(s.Name)}</td>
                          <td>${s.Barco__c ? esc(toTitleCase(s.Barco__c)) : '—'}</td>
                          <td class="mono">${s.Container_N__c ? esc(s.Container_N__c) : '—'}</td>
                          <td class="num">${s.ETD_Updated__c ? fmtDateFull(s.ETD_Updated__c) : '—'}</td>
                          <td class="num">${s.ETA__c ? fmtDateFull(s.ETA__c) : '—'}</td>
                        </tr>`).join('\n')}
                      </tbody>
                    </table>`
    : '<p class="pm-vacio">Este contrato no tiene embarques cargados.</p>';

  return {
    valor: c.Total_Value__c || 0,
    fin: c.EndDate || '',
    html: `                <tr class="hist-row" data-row="${rowId}" data-valor="${c.Total_Value__c || 0}" data-fin="${c.EndDate || ''}">
                  <td class="mono"><span class="hist-caret">▸</span>${esc(c.Nro_Proforma__c || c.ContractNumber)}</td>
                  <td><span class="cat-icon" aria-hidden="true">${icono}</span>${esc(productos.join(', ') || '—')}</td>
                  <td>${esc(toTitleCase(c.Puerto_origen__c || '—'))} → ${esc(toTitleCase(c.Puerto_Destino__c || '—'))}</td>
                  <td class="num"><b>${nEmb}</b></td>
                  <td class="num">${money(c.Total_Value__c || 0)}</td>
                  <td class="num">${c.EndDate ? fmtDateFull(c.EndDate) : '—'}</td>
                  <td><span class="status-pill st-good"><span class="dot"></span>Completado</span></td>
                </tr>
                <tr class="hist-detail" data-detail="${rowId}" hidden>
                  <td colspan="7">${detalle}
                  </td>
                </tr>`,
  };
});

const histTotalFOB = historicos.reduce((a, c) => a + (c.Total_Value__c || 0), 0);
const historicoHtml = historicoRows.length ? historicoRows.map(r => r.html).join('\n')
  : '                <tr><td colspan="7" class="pm-vacio">Todavía no hay contratos finalizados.</td></tr>';

// ---------- datos para exportar a Excel ----------
// Se embeben como JSON en la pagina; el boton de descarga los arma en el navegador.
const exportEmbarques = [];
contracts.forEach(c => {
  const ships = (c.Shippings__r ? c.Shippings__r.records : []).slice();
  const porEtd = ships.slice().sort((a, b) => {
    const da = a.ETD_Updated__c || a.ETD__c || '9999-12-31';
    const db = b.ETD_Updated__c || b.ETD__c || '9999-12-31';
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const seqMap = new Map(porEtd.map((s, i) => [s.Name, i + 1]));
  ships.forEach(s => {
    const d = delayInfo(s.ETD__c, s.ETD_Updated__c);
    exportEmbarques.push({
      Proforma: c.Nro_Proforma__c || c.ContractNumber,
      Ruta: `${toTitleCase(c.Puerto_origen__c || '')} - ${toTitleCase(c.Puerto_Destino__c || '')}`,
      Incoterm: c.Incoterm__c || '',
      Embarque: `${seqMap.get(s.Name)}/${ships.length}`,
      Factura: /^S\d+\/\d+\/\d+/.test(s.Name) ? '' : s.Name,
      Estado: statusPillClass(s.Status__c).label,
      Buque: s.Barco__c || '',
      Contenedor: s.Container_N__c || '',
      BL: s.Nro_BL__c || '',
      'ETD original': s.ETD__c || '',
      'ETD actualizado': s.ETD_Updated__c || '',
      ETA: s.ETA__c || '',
      'Atraso (dias)': d ? d.days : '',
      'Delayed Shipping': d && d.delayed ? 'Si' : 'No',
      Aprobado: s.Date_of_approval__c ? 'Si' : 'No',
      'Fecha aprobacion': s.Date_of_approval__c || '',
      Deliver: s.Deliver__c === 'Yes' ? 'Si' : 'No',
      'Fecha entrega': s.Delivery_Date__c || '',
      'Factura pagada': s.Paid__c === 'Yes' ? 'Si' : 'No',
      Monto: s.Amount_to_be_paid__c || '',
      'Fecha de pago': s.Invoice_payment_date__c || '',
    });
  });
});

const exportProductos = [];
contracts.forEach(c => {
  (c.Contratct_Products__r ? c.Contratct_Products__r.records : []).forEach(p => {
    exportProductos.push({
      Proforma: c.Nro_Proforma__c || c.ContractNumber,
      Producto: cleanProductName(p.Name),
      Familia: p.Principal_Product__c || '',
      'Precio unitario': p.Unit_Price__c || 0,
      Unidades: p.Quantity__c || 0,
      Cargado: p.Loaded__c || 0,
      'Pendiente de cargar': p.Unloaded__c || 0,
      Subtotal: p.Subtotal__c || 0,
    });
  });
});

const exportHistorico = historicos.map(c => ({
  Proforma: c.Nro_Proforma__c || c.ContractNumber,
  Estado: 'Completado',
  Producto: [...new Set((c.Contratct_Products__r ? c.Contratct_Products__r.records : []).map(p => p.Principal_Product__c).filter(Boolean))].join(', '),
  Ruta: `${toTitleCase(c.Puerto_origen__c || '')} - ${toTitleCase(c.Puerto_Destino__c || '')}`,
  Embarques: c.Shippings__r ? c.Shippings__r.records.length : 0,
  'Valor FOB': c.Total_Value__c || 0,
  Inicio: c.StartDate || '',
  Cierre: c.EndDate || '',
}));

const exportJson = JSON.stringify({
  cliente: 'SIPIA',
  actualizado: updatedStr,
  embarques: exportEmbarques,
  productos: exportProductos,
  historico: exportHistorico,
});

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'sipia_dashboard_template.html'), 'utf8');

const replacements = {
  '{{ALERT_MODAL}}': alertModalHtml,
  '{{UPDATED_DATE}}': updatedStr,
  '{{STAT_CONTRACTS}}': contracts.length,
  '{{STAT_SHIPMENTS_TOTAL}}': allShipments.length,
  '{{STAT_LOADED_PCT}}': (statusCounts.loaded / totalShip * 100).toFixed(1),
  '{{STAT_ONGOING_PCT}}': (statusCounts.ongoing / totalShip * 100).toFixed(1),
  '{{STAT_TBI_PCT}}': (statusCounts.tbi / totalShip * 100).toFixed(1),
  '{{STAT_LOADED_N}}': statusCounts.loaded,
  '{{STAT_ONGOING_N}}': statusCounts.ongoing,
  '{{STAT_TBI_N}}': statusCounts.tbi,
  '{{STAT_FOB}}': money(totalFOB),
  '{{EXPORT_DATA}}': exportJson,
  '{{HISTORICO_ROWS}}': historicoHtml,
  '{{HIST_COUNT}}': historicos.length,
  '{{HIST_FOB}}': money(histTotalFOB),
  '{{STAT_DELAYED_N}}': delayed.length,
  '{{STAT_DELAYED_TOTAL}}': allShipments.length,
  '{{STAT_DELAYED_AVG}}': avgDelay,
  '{{CONTRACTS}}': contractsHtml,
};

let html = TEMPLATE;
for (const [key, value] of Object.entries(replacements)) {
  html = html.split(key).join(String(value));
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, html, 'utf8');
console.log('OK - generado', OUT_FILE, 'con', contracts.length, 'contratos y', allShipments.length, 'embarques.');
