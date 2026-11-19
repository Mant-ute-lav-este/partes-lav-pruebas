// Precarga del planificador del portal (servidor v29+, DISEÑO\PLAN-PLANIFICADOR.md).
// Al sincronizar, la app pide al servidor los trabajos planificados del capataz para ayer, hoy y
// mañana, y los guarda en el móvil (clave «planDia» de kv) para ofrecerlos sin cobertura al añadir
// trabajos. Va en segundo plano: si falla, no se avisa y el parte se hace a mano como siempre.

import * as db from './db.js';
import { api } from './servidor.js';
import { fechaLocal, isoLocal, normaliza } from './util.js';
import { LINEAS, persona, trabajoNuevo } from './modelo.js';
import { pkValido, unirVias, mismoNombre } from './validaciones.js';

export const CLAVE_PLAN = 'planDia';
export const TIEMPO_PLAN = 15000;   // el servidor no puede cortar la llamada al portal: corta la app

/** Ayer, hoy y mañana (de madrugada el parte es de ayer; de noche se prepara el de mañana). */
export function fechasPlan(ahora = new Date()) {
  return [-1, 0, 1].map((n) => {
    const d = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + n);
    return fechaLocal(d);
  });
}

/**
 * Une lo descargado (`r`: { persona, fechas, trabajos }) con lo guardado (`previo`). Los días pedidos se
 * reemplazan enteros (un trabajo quitado del plan desaparece); los demás guardados se conservan si son
 * de la misma persona y no son anteriores a ayer. Cada trabajo va al día de su `fecha` (si no es uno de
 * los pedidos, no se guarda).
 * Forma: { persona, descargado, dias: { 'aaaa-mm-dd': [trabajos del portal] } }.
 */
export function unirPlan(previo, r, ahora = new Date()) {
  const desde = fechasPlan(ahora)[0];
  const dias = {};
  if (previo && previo.persona === r.persona && previo.dias && typeof previo.dias === 'object') {
    for (const [f, l] of Object.entries(previo.dias)) if (f >= desde && Array.isArray(l)) dias[f] = l;
  }
  const pedidas = Array.isArray(r.fechas) ? r.fechas : [];
  for (const f of pedidas) dias[f] = [];
  for (const t of Array.isArray(r.trabajos) ? r.trabajos : []) {
    const f = t && String(t.fecha || '');
    if (pedidas.includes(f)) dias[f].push(t);
  }
  return { persona: r.persona, descargado: isoLocal(ahora), dias };
}

/**
 * Descarga el plan y lo guarda. Nunca lanza error. Devuelve el plan guardado, o null si no se ha
 * guardado nada nuevo. Si la cuenta no ve la precarga (config.planificador.visible), se borra lo guardado.
 * Si el portal no da plan (sinPlan) o no hay red, se queda lo que hubiera.
 */
export async function descargarPlan(config, perfil, { ahora = new Date(), pedir = api } = {}) {
  try {
    if (!perfil || !perfil.token) return null;
    if (!(config && config.planificador && config.planificador.visible)) {
      await borrarPlan();
      return null;
    }
    const r = await pedir('planificado', { token: perfil.token, fechas: fechasPlan(ahora), persona: perfil.capataz || '' },
      { timeout: TIEMPO_PLAN, intentos: 1 });
    if (!r.visible) {
      await borrarPlan();
      return null;
    }
    if (r.sinPlan) return null;
    const plan = unirPlan(await db.kvGet(CLAVE_PLAN), r, ahora);
    await db.kvSet(CLAVE_PLAN, plan);
    return plan;
  } catch {
    return null;
  }
}

async function borrarPlan() {
  if (await db.kvGet(CLAVE_PLAN)) await db.kvSet(CLAVE_PLAN, null);
}

/** ¿El trabajo viene del plan del portal? */
export const esPlanificado = (t) => Boolean(t && Array.isArray(t.plan) && t.plan.length);

/** Ids del plan del trabajo como texto («172, 173»); '' si se añadió a mano. Lo usan la ficha, el PDF y el correo. */
export const idsPlan = (t) => (esPlanificado(t) ? t.plan.join(', ') : '');

/** «Planificado · 172» (o «· 172, 173»): la marca que sale en la ficha y en la lista de trabajos. */
export const marcaPlan = (t) => `Planificado · ${idsPlan(t)}`;

// ---------- Qué queda por añadir ----------

/** Plan del portal que corresponde a cada tipo de parte: FSP06 es el día (INFRA) y FSP05 la noche (SUPER). */
const PLAN_DE_TIPO = { INFRA: 'FSP06', SUPER: 'FSP05' };

/** Ids del planificador ya puestos en los trabajos de un parte (como texto). */
export function idsDelParte(p) {
  return new Set(((p && p.trabajos) || []).flatMap((t) => (t && Array.isArray(t.plan) ? t.plan.map(String) : [])));
}

/**
 * Ids ya puestos en OTROS partes de INFRA/SUPER del mismo día que hay en el móvil (p. ej. el de día y el
 * de noche). No cuentan las revisiones del mismo parte (misma referencia): esas llevan los mismos trabajos.
 */
export function idsUsadosEnOtros(partes, parte) {
  const s = new Set();
  for (const x of partes || []) {
    if (!x || x.id === parte.id || x.ref === parte.ref || x.fecha !== parte.fecha) continue;
    if (x.tipo !== 'INFRA' && x.tipo !== 'SUPER') continue;
    for (const id of idsDelParte(x)) s.add(id);
  }
  return s;
}

/**
 * Trabajos del plan que el capataz aún puede añadir a este parte: los del día del parte, si el plan es
 * suyo (si se cambió de capataz, no), sin los ya añadidos aquí ni en otro parte del día. Primero los de
 * su tipo; Juan pidió enseñarle todo lo suyo.
 */
export function pendientesDelPlan(plan, parte, usados = new Set()) {
  if (!plan || !plan.dias || !parte || parte.estado !== 'borrador' || parte.sinTrabajos) return [];
  if (!PLAN_DE_TIPO[parte.tipo] || !mismoNombre(plan.persona, parte.capataz)) return [];
  const ya = idsDelParte(parte);
  const lista = (Array.isArray(plan.dias[parte.fecha]) ? plan.dias[parte.fecha] : [])
    .filter((t) => t && t.id != null && !ya.has(String(t.id)) && !usados.has(String(t.id)));
  const suyo = PLAN_DE_TIPO[parte.tipo];
  return [...lista.filter((t) => t.plan === suyo), ...lista.filter((t) => t.plan !== suyo)];
}

/** Una línea para la lista de la hoja: plan, naturaleza, vías, aparato, PK, referencia y personas. */
export function detallePlan(t) {
  const vias = Array.isArray(t.vias) && t.vias.length ? `V${t.vias.join('-V')}` : '';
  const pk = t.pkInicio ? `PK ${t.pkInicio}${t.pkFin ? ` a ${t.pkFin}` : ''}` : '';
  const ref = t.sios ? `SIOS ${t.sios}` : t.incidencia ? `Incidencia ${t.incidencia}` : '';
  const n = Array.isArray(t.personal) ? t.personal.length : 0;
  return [t.plan, t.naturaleza, vias, t.aparato, pk, ref, n ? `${n} persona${n === 1 ? '' : 's'}` : '']
    .filter(Boolean).map(String).join(' · ');
}

// ---------- Del plan al parte ----------

const sinEspacios = (s) => normaliza(s).replace(/[\s\-.]/g, '');

/** Persona del portal → la de nuestra lista (por `lista`, nombre completo o corto); si no está, «añadida». */
export function personaDelPlan(x, trabajadores) {
  if (!x || typeof x !== 'object') return null;
  const claves = [x.lista, x.nombre, x.corto].filter(Boolean).map(normaliza);
  const t = (trabajadores || []).find((y) => y && claves.includes(normaliza(y.nombre)));
  if (t) return persona(t);
  // Habilitación: la nuestra, no los códigos del portal (son informativos); de alguien de fuera, vacía.
  const nombre = String(x.lista || x.corto || x.nombre || '').trim();
  return nombre ? persona({ nombre, empresa: x.empresa || '', otro: true }) : null;
}

/** Máquina del portal → la de nuestra lista (la matrícula/UIC está dentro de la descripción, o la misma descripción). */
export function maquinaDelPlan(m, maquinas) {
  if (!m || typeof m !== 'object') return null;
  const mat = sinEspacios(m.matricula);
  const des = sinEspacios(m.descripcion);
  const c = (maquinas || []).find((y) => {
    const d = sinEspacios(y && y.descripcion);
    return d && ((mat && d.includes(mat)) || (des && d === des));
  });
  if (c) return { descripcion: c.descripcion, otro: false };
  const texto = [m.descripcion, m.matricula].map((s) => String(s || '').trim()).filter(Boolean).join(' · ');
  return texto ? { descripcion: texto, otro: true } : null;
}

/** Trabajo nuevo relleno con lo que trae el plan. Lo que no encaja se deja vacío y se avisa. */
function trabajoDelPlan(t, parte, cfg, previo, avisos) {
  const x = trabajoNuevo(previo);
  x.plan = [String(t.id)];
  if (t.sios) x.referencia = { tipo: 'SIOS', codigo: String(t.sios), motivo: '' };
  else if (t.incidencia) x.referencia = { tipo: 'INCIDENCIA', codigo: String(t.incidencia), motivo: '' };
  const linea = (String(t.linea || '').match(/\d{3}/) || [''])[0];
  if (LINEAS.includes(linea)) x.linea = linea;
  const vias = (Array.isArray(t.vias) ? t.vias : []).map(String).filter((v) => /^[1-5]$/.test(v));
  if (parte.tipo === 'SUPER' || vias.length === 1) x.via = unirVias(vias);
  else if (vias.length > 1) avisos.push(`Elige la vía (en el plan: «${t.via || vias.join('-')}»).`);
  if (t.aparato) {
    const a = (cfg.aparatos || []).find((y) => y && sinEspacios(y.nombre) === sinEspacios(t.aparato));
    x.aparato = a ? a.nombre : String(t.aparato);
  }
  if (pkValido(t.pkInicio)) x.pkInicio = String(t.pkInicio).trim();
  if (pkValido(t.pkFin)) x.pkFin = String(t.pkFin).trim();
  if (t.naturaleza) {
    const lista = (cfg.motivos && cfg.motivos[parte.tipo === 'INFRA' ? 'infra' : 'super']) || [];
    const m = lista.find((y) => normaliza(y) === normaliza(t.naturaleza));
    if (m) x.motivoActuacion = m;
    else avisos.push(`Elige el motivo de actuación (en el plan: «${t.naturaleza}»).`);
  }
  if (t.titulo) x.descripcion = String(t.titulo);
  return x;
}

/** Personas y máquinas (ya pasadas a las nuestras) que trae un trabajo del plan. */
function equiposDelPlan(t, listas) {
  return {
    personas: (Array.isArray(t.personal) ? t.personal : []).map((x) => personaDelPlan(x, listas.trabajadores)).filter(Boolean),
    maquinas: (Array.isArray(t.maquinas) ? t.maquinas : []).map((m) => maquinaDelPlan(m, listas.maquinas)).filter(Boolean),
  };
}

/** Listas con las que se busca: las que pasa la pantalla (catálogo con los «otros», máquinas de equiposCfg) o las de la lista. */
const listasDe = (cfg, listas = {}) => ({
  trabajadores: listas.trabajadores || cfg.trabajadores || [],
  maquinas: listas.maquinas || cfg.maquinas || [],
});

/**
 * Añade al parte el trabajo `t` del plan: el trabajo relleno al final, y su personal y sus máquinas
 * sumados a los del parte sin repetir (los trabajos de un mismo grupo los comparten). Si el capataz ya
 * contestó «No» a «¿Se ha usado maquinaria?», no se le cambia: se avisa. Cambia el parte y devuelve los
 * avisos para el capataz (lo que tiene que revisar). `listas`: { trabajadores, maquinas } para buscar.
 */
export function cargarDelPlan(parte, t, config, listas) {
  const cfg = config || {};
  const avisos = [];
  const previo = parte.trabajos[parte.trabajos.length - 1] || null;
  parte.trabajos.push(trabajoDelPlan(t, parte, cfg, previo, avisos));
  const { personas, maquinas } = equiposDelPlan(t, listasDe(cfg, listas));
  const ya = new Set(parte.personal.map((y) => normaliza(y.nombre)));
  let fuera = 0;
  for (const y of personas) {
    if (ya.has(normaliza(y.nombre))) continue;
    parte.personal.push(y);
    ya.add(normaliza(y.nombre));
    if (y.otro) fuera++;
  }
  if (fuera) avisos.push(fuera === 1 ? '1 persona no está en la lista: va como «añadida».' : `${fuera} personas no están en la lista: van como «añadidas».`);
  if (!Array.isArray(parte.maquinas)) parte.maquinas = [];
  const yaM = new Set(parte.maquinas.map((y) => normaliza(y.descripcion)));
  const nuevas = maquinas.filter((y) => !yaM.has(normaliza(y.descripcion)) && yaM.add(normaliza(y.descripcion)));
  if (nuevas.length && parte.usaMaquinaria === false) {
    avisos.push(`El plan lleva maquinaria (${nuevas.map((y) => y.descripcion).join(', ')}) y en el parte pone que no se ha usado: revísalo.`);
  } else if (nuevas.length) {
    parte.maquinas.push(...nuevas);
    parte.usaMaquinaria = true;
    const escritas = nuevas.filter((y) => y.otro).length;
    if (escritas) avisos.push(escritas === 1 ? '1 máquina no está en la lista: va escrita a mano.' : `${escritas} máquinas no están en la lista: van escritas a mano.`);
  }
  return avisos;
}

/** El trabajo del plan (en cualquier día guardado) con alguno de esos ids. */
function buscarEnPlan(plan, ids) {
  const quiero = new Set((ids || []).map(String));
  for (const lista of Object.values((plan && plan.dias) || {})) {
    for (const t of Array.isArray(lista) ? lista : []) if (t && quiero.has(String(t.id))) return t;
  }
  return null;
}

/**
 * Al quitar el trabajo `idx` (añadido del plan por error): las personas y máquinas que trajo y que no
 * necesita ningún otro trabajo del plan que siga en el parte (el capataz nunca). Si el plan ya no está en
 * el móvil, no se sabe: `sinDatos`. No cambia nada.
 */
export function sobrantesAlQuitar(parte, idx, plan, config, listas) {
  const t = parte.trabajos[idx];
  const deEste = esPlanificado(t) && buscarEnPlan(plan, t.plan);
  if (!deEste) return { personas: [], maquinas: [], sinDatos: esPlanificado(t) };
  const ls = listasDe(config || {}, listas);
  const traidos = equiposDelPlan(deEste, ls);
  const siguen = { personas: new Set([normaliza(parte.capataz)]), maquinas: new Set() };
  parte.trabajos.forEach((x, i) => {
    const otro = i !== idx && esPlanificado(x) && buscarEnPlan(plan, x.plan);
    if (!otro) return;
    const e = equiposDelPlan(otro, ls);
    e.personas.forEach((y) => siguen.personas.add(normaliza(y.nombre)));
    e.maquinas.forEach((y) => siguen.maquinas.add(normaliza(y.descripcion)));
  });
  const enParte = (lista, prop) => new Set((lista || []).map((y) => normaliza(y[prop])));
  const personasParte = enParte(parte.personal, 'nombre');
  const maquinasParte = enParte(parte.maquinas, 'descripcion');
  return {
    personas: [...new Set(traidos.personas.map((y) => y.nombre))]
      .filter((n) => personasParte.has(normaliza(n)) && !siguen.personas.has(normaliza(n))),
    maquinas: [...new Set(traidos.maquinas.map((y) => y.descripcion))]
      .filter((d) => maquinasParte.has(normaliza(d)) && !siguen.maquinas.has(normaliza(d))),
    sinDatos: false,
  };
}

/** Quita del parte las personas y máquinas de `sobrantesAlQuitar`. Sin máquinas, «¿Se ha usado maquinaria?» se vuelve a preguntar. */
export function quitarSobrantes(parte, s) {
  const p = new Set(s.personas.map(normaliza));
  const m = new Set(s.maquinas.map(normaliza));
  parte.personal = parte.personal.filter((y) => !p.has(normaliza(y.nombre)));
  if (Array.isArray(parte.maquinas) && m.size) {
    parte.maquinas = parte.maquinas.filter((y) => !m.has(normaliza(y.descripcion)));
    if (!parte.maquinas.length) parte.usaMaquinaria = null;
  }
}
