/**
 * Control de acceso por cliente para los dashboards de Luma Foods.
 *
 * Corre en Cloudflare Pages ANTES de entregar cualquier archivo: si no hay
 * credenciales válidas, el contenido nunca sale del servidor.
 *
 * Cómo se configuran las claves (panel de Cloudflare → Pages → Settings →
 * Environment variables), una por cliente, usando el nombre de la carpeta:
 *
 *    carpeta /sipia/   →   USER_SIPIA  (opcional, por defecto "sipia")
 *                          PASS_SIPIA  (obligatoria)
 *
 *    carpeta /semvra/  →   USER_SEMVRA / PASS_SEMVRA
 *
 * La portada ("/") y los archivos compartidos ("/assets/...") aceptan las
 * credenciales de CUALQUIER cliente configurado.
 *
 * Importante: si un cliente no tiene PASS_ definida, su carpeta queda
 * BLOQUEADA (no abierta). Así una carpeta nueva nunca queda expuesta por olvido.
 */

const RUTAS_COMPARTIDAS = ['', 'assets', 'index.html', 'favicon.ico', 'robots.txt'];

function pedirCredenciales(mensaje) {
  return new Response(mensaje, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Luma Foods — Panel de clientes", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// Comparación de tiempo constante: evita filtrar la clave por diferencias de tiempo.
function igualSeguro(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function leerAuth(request) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decodificado = atob(header.slice(6));
    const corte = decodificado.indexOf(':');
    if (corte < 0) return null;
    return { usuario: decodificado.slice(0, corte), clave: decodificado.slice(corte + 1) };
  } catch {
    return null;
  }
}

// Devuelve los clientes que tienen clave configurada: { sipia: {usuario, clave}, ... }
function clientesConfigurados(env) {
  const salida = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (k.startsWith('PASS_') && typeof v === 'string' && v.length) {
      const slug = k.slice(5).toLowerCase();
      salida[slug] = { usuario: env['USER_' + k.slice(5)] || slug, clave: v };
    }
  }
  return salida;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const primerSegmento = (url.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();

  const clientes = clientesConfigurados(env);

  // Si todavía no se cargó ninguna clave, se bloquea todo (nunca abierto por defecto).
  if (Object.keys(clientes).length === 0) {
    return new Response(
      'Acceso no configurado. Falta cargar las variables PASS_<CLIENTE> en Cloudflare Pages.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  const credenciales = leerAuth(request);
  if (!credenciales) return pedirCredenciales('Ingresá tu usuario y contraseña.');

  const esRutaCompartida = RUTAS_COMPARTIDAS.includes(primerSegmento);

  // Rutas compartidas: vale la credencial de cualquier cliente.
  if (esRutaCompartida) {
    const alguna = Object.values(clientes).some(
      c => igualSeguro(credenciales.usuario, c.usuario) && igualSeguro(credenciales.clave, c.clave)
    );
    if (!alguna) return pedirCredenciales('Usuario o contraseña incorrectos.');
    return next();
  }

  // Carpeta de un cliente: solo vale SU credencial.
  const esperado = clientes[primerSegmento];
  if (!esperado) return pedirCredenciales('Este panel todavía no tiene acceso configurado.');

  const ok = igualSeguro(credenciales.usuario, esperado.usuario) &&
             igualSeguro(credenciales.clave, esperado.clave);
  if (!ok) return pedirCredenciales('Usuario o contraseña incorrectos.');

  return next();
}
