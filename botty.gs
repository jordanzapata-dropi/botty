/**
 * Bot de Google Chat "Botty"
 *
 * Comandos (ID configurado en Google Cloud → Chat API → Comandos):
 *   1 /generarmeet    (abre un formulario)
 *   9 /meet           [Título | AAAA-MM-DD HH:MM | minutos | @Persona, correo]  → reunión rápida
 *   2 /configurarjira (abre un diálogo)
 *   3 /help
 *   4 /status
 *   5 /misreuniones
 *   6 /cancelarmeet   TECH-123
 *   7 /finalizar      TECH-123 [minutos]
 *   8 /borrarconfig
 *
 * Propiedades del script (comunes): JIRA_DOMAIN, JIRA_PROJECT, JIRA_WORK_DOMAIN_ID
 * Cada usuario guarda su token con /configurarjira (propiedades de usuario, privadas).
 */

const COMANDOS = {
  1: 'generarmeet', 2: 'configurarjira', 3: 'help', 4: 'status',
  5: 'misreuniones', 6: 'cancelarmeet', 7: 'finalizar', 8: 'borrarconfig', 9: 'meet'
};
const MEET_RAPIDA = { titulo: 'Reunión rápida', duracion: 30 }; // valores de /meet sin parámetros
// Palabras que también se aceptan escritas como texto normal
const ALIAS = { ayuda: 'help', estado: 'status', cancelar: 'cancelarmeet' };

const LIMITES = { minDuracion: 5, maxDuracion: 480, maxInvitados: 20 };
const JIRA_ESTADO_FINAL = /finaliz|done|listo|hecho|terminad/i;
const JIRA_ESTADO_CANCELADO = /cancel|descart|rechaz/i;

// ---------------- Puntos de entrada ----------------
function onMessage(event) { return manejar(event); }
function onAppCommand(event) { return manejar(event); }

function onAddedToSpace(event) {
  return responder(event, '👋 ¡Hola! Soy *Botty*. Escribe /help para ver lo que puedo hacer.\n' +
    'Si es tu primera vez, empieza con /configurarjira.');
}

function responder(event, texto) {
  return (event && event.chat)
    ? { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: texto } } } } }
    : { text: texto };
}

function manejar(event) {
  if (!event) return 'Esta función se ejecuta desde Google Chat. Para probar en el editor usa probarDesdeEditor().';

  const esAddon = !!event.chat;
  let msg, commandId;
  if (esAddon) {
    const p = event.chat.appCommandPayload || event.chat.messagePayload || {};
    msg = p.message || {};
    commandId = p.appCommandMetadata ? p.appCommandMetadata.appCommandId
              : (msg.slashCommand ? msg.slashCommand.commandId : null);
  } else {
    msg = event.message || {};
    commandId = msg.slashCommand ? msg.slashCommand.commandId : null;
  }

  const textoPlano = (msg.text || '').trim();
  const primeraPalabra = (textoPlano.match(/^\/?([a-záéíóú]+)/i) || [, ''])[1].toLowerCase();
  const comando = COMANDOS[commandId] || ALIAS[primeraPalabra] ||
                  (Object.values(COMANDOS).includes(primeraPalabra) ? primeraPalabra : null) ||
                  (/^\/?generar\s+meet/i.test(textoPlano) ? 'generarmeet' : null);

  const args = ((msg.argumentText && msg.argumentText.trim()) ? msg.argumentText : textoPlano)
    .trim().replace(/^\/?(generar\s+meet\b|[a-záéíóú]+)/i, '').trim();

  const payload = esAddon ? (event.chat.appCommandPayload || event.chat.messagePayload || {}) : event;
  const ctx = {
    args,
    espacio: payload.space || msg.space || null,
    solicitante: (esAddon ? (event.chat.user && event.chat.user.email) : (event.user && event.user.email))
                 || (msg.sender && msg.sender.email) || '',
    menciones: (msg.annotations || [])
      .filter(a => a.type === 'USER_MENTION' && a.userMention && a.userMention.user &&
                   a.userMention.user.type === 'HUMAN')
      .map(a => a.userMention.user.email || a.userMention.user.name)
  };

  if (comando === 'generarmeet' && commandId == 1) {
    if (!cfgJira().token) return responder(event, '⚙️ Antes de usar el bot, configura tu cuenta de Jira con /configurarjira');
    return dialogoNuevaMeet(esChatCompartido(ctx.espacio));
  }

  if (comando === 'configurarjira') {
    if (commandId == 2) return dialogoConfigJira();
    // Escrito como texto normal: Chat no permite abrir diálogos desde un mensaje
    return responder(event, '⚙️ Para configurar Jira, escribe / y elige *configurarjira* del menú de comandos ' +
      '(si no aparece, recarga Google Chat).');
  }

  const acciones = {
    generarmeet:  () => generarMeet(ctx.args, ctx.menciones, ctx.solicitante, ctx.espacio), // escrito como texto
    meet:         () => meetRapida(ctx),
    help:         () => textoAyuda(),
    status:       () => estado(ctx.solicitante),
    misreuniones: () => misReuniones(),
    cancelarmeet: () => cancelarMeet(ctx.args, ctx.solicitante),
    finalizar:    () => finalizar(ctx.args),
    borrarconfig: () => borrarConfig()
  };

  let texto;
  try {
    texto = acciones[comando] ? acciones[comando]()
          : '🤔 No reconocí ese comando. Escribe /help para ver las opciones.';
  } catch (e) {
    console.error(comando + ': ' + e.stack);
    texto = '❌ Error: ' + e.message;
  }
  return responder(event, texto);
}

// Pruebas desde el editor
function probarDesdeEditor() { Logger.log(generarMeet('Prueba bot | 2026-10-01 15:00 | 30')); }
function probarStatus() { Logger.log(estado(Session.getActiveUser().getEmail())); }

// ---------------- /help ----------------
function textoAyuda() {
  return [
    '*🤖 Botty: comandos disponibles*',
    '',
    '*/generarmeet*: abre un formulario para crear la reunión (título, fecha, hora, duración, invitados).',
    '*/meet*: reunión rápida de 30 min que empieza ya. En un chat grupal invita a todos los miembros.',
    '   /meet @Diego Pérez: lo mismo, invitando solo a esa persona (también acepta correos).',
    '   /meet Daily de equipo @Diego Pérez: con título propio.',
    '   Formato completo: /meet Título | AAAA-MM-DD HH:MM | minutos | @Persona',
    '',
    'Ambos crean el Meet, invitan a las personas, les avisan por Chat y crean la tarea No Code en Jira (In Progress).',
    '',
    '*/misreuniones*: tus próximas reuniones creadas con el bot (7 días).',
    '*/finalizar* TECH-123 [minutos]: registra el tiempo en Jira y pasa la tarea a Finalizada.',
    '*/cancelarmeet* TECH-123: cancela el evento (avisa a los invitados) y lo anota en Jira.',
    '',
    '*/status*: revisa que tu configuración esté bien.',
    '*/configurarjira*: guarda o cambia tu token de Jira.',
    '*/borrarconfig*: borra tu token y configuración.',
    '*/help*: muestra esta ayuda.'
  ].join('\n');
}

// ---------------- /status ----------------
function estado(solicitante) {
  const c = cfgJira();
  const lineas = ['*🩺 Estado de tu configuración*', ''];
  const ok = (cond, si, no) => lineas.push((cond ? '✅ ' : '❌ ') + (cond ? si : no));

  ok(c.dominio, `Sitio de Jira: ${c.dominio}`, 'Falta JIRA_DOMAIN en las propiedades del script (avisa al administrador del bot)');

  if (!c.token) {
    lineas.push('❌ Jira sin configurar: usa /configurarjira');
  } else {
    try {
      const yo = jira('/myself');
      lineas.push(`✅ Token de Jira válido (${yo.displayName})`);
      try {
        const pr = jira('/project/' + encodeURIComponent(c.proyecto));
        lineas.push(`✅ Proyecto: ${pr.key} (${pr.name})`);
      } catch (e) { lineas.push(`❌ No tienes acceso al proyecto ${c.proyecto}`); }
      ok(c.workDomain, `Work Domain: ${c.workDomain}`, 'Falta el Work Domain: configúralo con /configurarjira');
      try {
        ok(jiraAccountId(solicitante), `Las tareas se asignarán a ${solicitante}`,
           `No encontré a ${solicitante} en Jira; las tareas quedarán sin asignar`);
      } catch (e) { lineas.push('⚠️ No pude verificar tu usuario en Jira'); }
    } catch (e) {
      lineas.push('❌ Jira rechazó tu token (¿venció o lo revocaste?): usa /configurarjira');
    }
  }

  try {
    const cal = Calendar.Calendars.get('primary');
    lineas.push(`✅ Google Calendar conectado (zona horaria ${cal.timeZone})`);
  } catch (e) { lineas.push('❌ Sin acceso a Google Calendar: ' + e.message); }

  try {
    Chat.Spaces.list({ pageSize: 1 });
    lineas.push('✅ Permisos de Google Chat para enviar el Meet a los invitados');
  } catch (e) { lineas.push('❌ Sin permisos de Chat para avisar a invitados: ' + e.message); }

  lineas.push('', `🕒 Zona horaria del bot: ${Session.getScriptTimeZone()}`);
  return lineas.join('\n');
}

// ---------------- /generarmeet ----------------
function generarMeet(argumentText, mencionesIds, solicitante, espacio) {
  try {
    const d = parsearArgumentos(argumentText || '');
    return crearReunion(Object.assign(d, { mencionesIds, solicitante, espacio }));
  } catch (e) {
    return '❌ ' + e.message + '\nEscribe /help para ver el formato.';
  }
}

/**
 * /meet
 *   /meet                        → reunión estándar que empieza ya
 *   /meet @Persona, correo       → lo mismo, invitando a esas personas
 *   /meet Título | fecha | min…  → formato completo
 */
function meetRapida(ctx) {
  if (ctx.args.includes('|')) return generarMeet(ctx.args, ctx.menciones, ctx.solicitante, ctx.espacio);

  // Sin "|": lo que va antes del primer @ o correo es el título; lo demás, los invitados
  const reCorreo = /[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+/;
  const posArroba = ctx.args.search(/(^|\s)@/);
  const posCorreo = ctx.args.search(reCorreo);
  const cortes = [posArroba, posCorreo].filter(i => i >= 0);
  const corte = cortes.length ? Math.min(...cortes) : ctx.args.length;
  const titulo = ctx.args.slice(0, corte).trim() || MEET_RAPIDA.titulo;
  const resto = ctx.args.slice(corte);

  const correos = (resto.match(new RegExp(reCorreo.source, 'g')) || []).map(c => c.toLowerCase());
  const nombres = [];
  if (!ctx.menciones.length) {
    // @Nombre escrito a mano: se busca en el directorio
    resto.replace(new RegExp(reCorreo.source, 'g'), '').split(/[,;]+/).map(t => t.trim())
      .filter(t => t.startsWith('@')).forEach(t => nombres.push(t.slice(1).trim()));
  }

  return crearReunion({
    titulo, inicio: new Date(), duracion: MEET_RAPIDA.duracion,
    correos, nombres, mencionesIds: ctx.menciones, solicitante: ctx.solicitante, espacio: ctx.espacio
  });
}

/** Lógica común: valida, crea el evento con Meet, la tarea en Jira y avisa a los invitados. */
function crearReunion({ titulo, inicio, duracion, correos, nombres, mencionesIds, solicitante, espacio, sinMiembros }) {
  try {
    if (!cfgJira().token) return '⚙️ Antes de usar el bot, configura tu cuenta de Jira con /configurarjira';
    if (inicio.getTime() < Date.now() - 5 * 60000) throw new Error('La fecha ya pasó. Usa una fecha futura.');
    if (duracion < LIMITES.minDuracion || duracion > LIMITES.maxDuracion)
      throw new Error(`La duración debe estar entre ${LIMITES.minDuracion} y ${LIMITES.maxDuracion} minutos.`);

    // En un chat grupal o espacio, si no mencionas a nadie, se invita a todos los miembros
    let miembrosDelChat = false;
    if (!sinMiembros && !correos.length && !nombres.length && !(mencionesIds || []).length && esChatCompartido(espacio)) {
      mencionesIds = listarMiembrosHumanos(espacio.name);
      miembrosDelChat = true;
    }
    let { invitados, noEncontrados } = resolverInvitados(correos, nombres, mencionesIds || []);
    invitados = invitados.filter(e => e !== (solicitante || '').toLowerCase()); // tú ya eres el organizador
    if (invitados.length > LIMITES.maxInvitados)
      throw new Error(`Máximo ${LIMITES.maxInvitados} invitados por reunión.`);

    const fin = new Date(inicio.getTime() + duracion * 60000);
    const evento = crearEventoConMeet(titulo, inicio, fin, invitados);
    const meetLink = evento.hangoutLink || 'Sin enlace de Meet';
    const fecha = Utilities.formatDate(inicio, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');

    let respuesta = `✅ *${titulo}*\n📅 ${fecha} (${duracion} min)\n🎥 Meet: ${meetLink}\n🗓️ Evento: ${evento.htmlLink}`;

    // Jira: si falla, la reunión igual queda creada
    try {
      const issueKey = crearTareaJira({
        titulo, inicio, fin, meetLink, eventoLink: evento.htmlLink, invitados,
        solicitante: solicitante || cfgJira().email
      });
      Calendar.Events.patch({ extendedProperties: { private: { generarMeet: '1', jiraKey: issueKey } } },
                            'primary', evento.id);
      respuesta += `\n📌 Jira: https://${cfgJira().dominio}/browse/${issueKey}`;
    } catch (e) {
      console.error('Jira: ' + e.message);
      respuesta += `\n⚠️ La reunión se creó, pero falló la tarea en Jira: ${e.message.slice(0, 200)}`;
    }

    const enviados = [], fallidos = [];
    invitados.forEach(email => {
      try {
        enviarPorChat(email, `👋 Te invito a *${titulo}*\n📅 ${fecha} (${duracion} min)\n🎥 ${meetLink}`);
        enviados.push(email);
      } catch (e) { console.error('Chat a ' + email + ': ' + e.message); fallidos.push(email); }
    });

    if (miembrosDelChat) respuesta += `\n👥 Invité a los miembros de este chat${invitados.length ? '' : ' (no encontré a nadie más)'}`;
    if (enviados.length) respuesta += `\n📨 Enviado por Chat a: ${enviados.join(', ')}`;
    if (!invitados.length && (correos.length || nombres.length || (mencionesIds || []).length))
      respuesta += '\n⚠️ No pude obtener el correo de ningún invitado';
    if (noEncontrados.length) respuesta += `\n❓ No encontré en el directorio a: ${noEncontrados.join(', ')} (usa su correo)`;
    if (fallidos.length) respuesta += `\n⚠️ No se pudo avisar por Chat a: ${fallidos.join(', ')} (sí quedaron invitados en Calendar)`;
    return respuesta;
  } catch (e) {
    return '❌ ' + e.message + '\nEscribe /help para ver el formato.';
  }
}

/** true si el bot está en un chat grupal o espacio (no en el chat 1:1 con el bot). */
function esChatCompartido(espacio) {
  if (!espacio || espacio.singleUserBotDm) return false;
  return espacio.spaceType === 'GROUP_CHAT' || espacio.spaceType === 'SPACE' ||
         espacio.type === 'ROOM' || espacio.type === 'GROUP_CHAT';
}

/** Devuelve los IDs ("users/123") de las personas del chat. */
function listarMiembrosHumanos(nombreEspacio) {
  const ids = [];
  let pageToken;
  do {
    const r = Chat.Spaces.Members.list(nombreEspacio, { pageSize: 100, pageToken, filter: 'member.type = "HUMAN"' });
    (r.memberships || []).forEach(m => m.member && ids.push(m.member.name));
    pageToken = r.nextPageToken;
  } while (pageToken && ids.length < LIMITES.maxInvitados + 1);
  console.log('Miembros del chat: ' + ids.length);
  return ids;
}

// ---------------- /misreuniones ----------------
function misReuniones() {
  const ahora = new Date();
  const r = Calendar.Events.list('primary', {
    timeMin: ahora.toISOString(),
    timeMax: new Date(ahora.getTime() + 7 * 86400000).toISOString(),
    privateExtendedProperty: 'generarMeet=1',
    singleEvents: true, orderBy: 'startTime', maxResults: 20
  });
  const items = r.items || [];
  if (!items.length) return '📭 No tienes reuniones creadas con el bot en los próximos 7 días.';

  const tz = Session.getScriptTimeZone();
  const dominio = cfgJira().dominio;
  return ['*📅 Tus próximas reuniones (7 días)*', ''].concat(items.map(ev => {
    const hora = Utilities.formatDate(new Date(ev.start.dateTime || ev.start.date), tz, 'EEE dd/MM HH:mm');
    const key = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.jiraKey;
    return `• *${hora}*: ${ev.summary}` +
           (key ? ` · <https://${dominio}/browse/${key}|${key}>` : '') +
           (ev.hangoutLink ? ` · <${ev.hangoutLink}|Meet>` : '');
  })).join('\n');
}

// ---------------- /cancelarmeet ----------------
function cancelarMeet(args, solicitante) {
  const key = validarKey(args);
  const ev = buscarEventoPorKey(key);
  if (!ev) return `❓ No encontré una reunión creada por ti con la tarea ${key}.`;

  Calendar.Events.remove('primary', ev.id, { sendUpdates: 'all' });
  let resp = `🗑️ Reunión *${ev.summary}* cancelada. Se avisó a los invitados.`;

  try {
    jiraComentario(key, `Reunión cancelada desde Google Chat por ${solicitante || 'el organizador'}.`);
    const t = moverA(key, JIRA_ESTADO_CANCELADO);
    resp += t ? `\n📌 ${key} pasó a *${t}*.` : `\n📌 Dejé un comentario en ${key} (no hay estado de cancelación en el flujo).`;
  } catch (e) { resp += `\n⚠️ No pude actualizar ${key} en Jira: ${e.message.slice(0, 150)}`; }
  return resp;
}

// ---------------- /finalizar ----------------
function finalizar(args) {
  const partes = args.trim().split(/\s+/);
  const key = validarKey(partes[0]);
  let minutos = parseInt(partes[1], 10);
  let inicio = new Date();

  const ev = buscarEventoPorKey(key, true);
  if (ev) {
    inicio = new Date(ev.start.dateTime);
    if (!minutos) minutos = Math.round((new Date(ev.end.dateTime) - inicio) / 60000);
  }
  if (!minutos) return `❓ No encontré la reunión de ${key}. Indica los minutos: /finalizar ${key} 60`;

  jira(`/issue/${key}/worklog`, 'post', {
    timeSpentSeconds: minutos * 60,
    started: Utilities.formatDate(inicio, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss.SSSZ")
  });
  const t = moverA(key, JIRA_ESTADO_FINAL);
  return `🏁 ${key}: registré ${minutos} min` + (t ? ` y pasó a *${t}*.` : ', pero no encontré el estado Finalizada en el flujo.');
}

// ---------------- /borrarconfig ----------------
function borrarConfig() {
  PropertiesService.getUserProperties().deleteAllProperties();
  return '🧹 Borré tu token y tu configuración de Jira. Para volver a usar el bot, usa /configurarjira.';
}

// ---------------- Utilidades de comandos ----------------
function validarKey(texto) {
  const key = (texto || '').trim().split(/\s+/)[0].toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error('Indica la clave de la tarea, por ejemplo: TECH-123');
  return key;
}

/** Busca el evento que el bot creó para una tarea de Jira (desde 30 días atrás). */
function buscarEventoPorKey(key, incluirPasados) {
  const r = Calendar.Events.list('primary', {
    privateExtendedProperty: 'jiraKey=' + key,
    timeMin: new Date(Date.now() - (incluirPasados ? 30 : 1) * 86400000).toISOString(),
    singleEvents: true, maxResults: 5
  });
  return (r.items || [])[0] || null;
}

/** Mueve la tarea al primer estado que coincida con el patrón. Devuelve el nombre o null. */
function moverA(key, patron) {
  const { transitions } = jira(`/issue/${key}/transitions`);
  const t = transitions.find(x => patron.test(x.to.name) || patron.test(x.name));
  if (!t) { console.error('Transiciones de ' + key + ': ' + transitions.map(x => x.to.name).join(', ')); return null; }
  jira(`/issue/${key}/transitions`, 'post', { transition: { id: t.id } });
  return t.to.name;
}

function jiraComentario(key, texto) {
  jira(`/issue/${key}/comment`, 'post', {
    body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: texto }] }] }
  });
}

function parsearArgumentos(texto) {
  const partes = texto.split('|').map(s => s.trim());
  const titulo = partes[0] || 'Reunión';
  let inicio;
  if (partes[1]) {
    inicio = new Date(partes[1].replace(' ', 'T'));
    if (isNaN(inicio)) throw new Error('Fecha inválida. Formato: AAAA-MM-DD HH:MM');
  } else {
    inicio = new Date(Date.now() + 15 * 60000); // en 15 minutos si no se indica
  }
  const duracion = parseInt(partes[2], 10) || 60;
  // 4ª parte: correos y/o @Nombres separados por coma
  const correos = [], nombres = [];
  (partes[3] || '').split(/[,;]+/).map(t => t.trim()).filter(Boolean).forEach(t => {
    t.split(/\s+/).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))
      .forEach(x => correos.push(x.toLowerCase()));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) && t.startsWith('@')) nombres.push(t.slice(1).trim());
  });
  return { titulo, inicio, duracion, correos, nombres };
}

/**
 * Convierte menciones (@) y nombres en correos usando el directorio de Dropi.
 * - Menciones reales (chats grupales/espacios): se usa el ID exacto de la persona.
 * - @Nombre escrito a mano (chat con el bot): se busca en el directorio; solo se usa si hay 1 coincidencia.
 */
function resolverInvitados(correos, nombres, mencionesIds) {
  const set = new Set(correos);
  const noEncontrados = [];

  let resueltas = 0;
  mencionesIds.forEach(id => {
    if (id.includes('@')) { set.add(id.toLowerCase()); resueltas++; return; } // Chat ya dio el correo
    try {
      const persona = People.People.get(id.replace('users/', 'people/'), {
        personFields: 'emailAddresses',
        sources: ['READ_SOURCE_TYPE_PROFILE', 'READ_SOURCE_TYPE_DOMAIN_CONTACT']
      });
      console.log('Mención ' + id + ': ' + JSON.stringify(persona));
      const email = persona.emailAddresses && persona.emailAddresses[0].value;
      if (email) { set.add(email.toLowerCase()); resueltas++; }
    } catch (e) { console.error('Mención ' + id + ': ' + e.message); }
  });

  // Si alguna mención no dio correo, se buscan los nombres en el directorio
  if (resueltas < Math.max(mencionesIds.length, nombres.length)) {
    nombres.forEach(nombre => {
      try {
        const r = People.People.searchDirectoryPeople({
          query: nombre,
          readMask: 'emailAddresses,names',
          sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE']
        });
        console.log('Búsqueda "' + nombre + '": ' + JSON.stringify(r));
        const personas = (r.people || []).filter(p => p.emailAddresses);
        if (personas.length === 1) set.add(personas[0].emailAddresses[0].value.toLowerCase());
        else noEncontrados.push(`${nombre} (${personas.length ? personas.length + ' coincidencias' : 'sin coincidencias'})`);
      } catch (e) {
        console.error('Búsqueda ' + nombre + ': ' + e.message);
        noEncontrados.push(nombre);
      }
    });
  }
  return { invitados: [...set], noEncontrados };
}

/** Envía un mensaje directo en Google Chat (como el usuario que usa el bot). */
function enviarPorChat(email, texto) {
  let espacio;
  try {
    espacio = Chat.Spaces.findDirectMessage({ name: 'users/' + email });
  } catch (e) {
    // Si aún no existe un chat directo con esa persona, se crea
    espacio = Chat.Spaces.setup({
      space: { spaceType: 'DIRECT_MESSAGE' },
      memberships: [{ member: { name: 'users/' + email, type: 'HUMAN' } }]
    });
  }
  Chat.Spaces.Messages.create({ text: texto }, espacio.name);
}

function crearEventoConMeet(titulo, inicio, fin, invitados) {
  const recurso = {
    summary: titulo,
    attendees: (invitados || []).map(email => ({ email })),
    extendedProperties: { private: { generarMeet: '1' } }, // marca para /misreuniones, /cancelarmeet, /finalizar
    start: { dateTime: inicio.toISOString() },
    end: { dateTime: fin.toISOString() },
    conferenceData: {
      createRequest: {
        requestId: Utilities.getUuid(),
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  };
  return Calendar.Events.insert(recurso, 'primary', { conferenceDataVersion: 1, sendUpdates: 'all' });
}

// ---------------- Jira ----------------
const JIRA_TIPO_NO_CODE = '10050';        // Tipo "No Code" (proyecto TECH)
const JIRA_ESTADO_DESTINO = /in progress|en curso|en progreso/i; // Estado final de la tarea

/** Configuración de Jira: la del usuario que usa el bot, con valores comunes por defecto. */
function cfgJira() {
  const u = PropertiesService.getUserProperties();
  const s = PropertiesService.getScriptProperties();
  return {
    dominio:    s.getProperty('JIRA_DOMAIN'),
    email:      u.getProperty('JIRA_EMAIL'),
    token:      u.getProperty('JIRA_TOKEN'),
    proyecto:   u.getProperty('JIRA_PROJECT') || s.getProperty('JIRA_PROJECT'),
    workDomain: u.getProperty('JIRA_WORK_DOMAIN_ID') || s.getProperty('JIRA_WORK_DOMAIN_ID')
  };
}

function jira(ruta, metodo, cuerpo, credenciales) {
  const c = cfgJira();
  const email = credenciales ? credenciales.email : c.email;
  const token = credenciales ? credenciales.token : c.token;
  const opciones = {
    method: metodo || 'get',
    contentType: 'application/json',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(email + ':' + token),
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  };
  if (cuerpo) opciones.payload = JSON.stringify(cuerpo);
  const resp = UrlFetchApp.fetch(`https://${c.dominio}/rest/api/3${ruta}`, opciones);
  const codigo = resp.getResponseCode();
  if (codigo >= 300) throw new Error(`Jira respondió ${codigo} en ${ruta}: ${resp.getContentText()}`);
  const texto = resp.getContentText();
  return texto ? JSON.parse(texto) : {};
}

/** Busca el accountId de Jira a partir del correo. */
function jiraAccountId(email) {
  if (!email) return null;
  const usuarios = jira('/user/search?query=' + encodeURIComponent(email));
  const u = usuarios.find(x => (x.emailAddress || '').toLowerCase() === email.toLowerCase()) || usuarios[0];
  return u ? u.accountId : null;
}

function crearTareaJira({ titulo, inicio, fin, meetLink, eventoLink, invitados, solicitante }) {
  const c = cfgJira();
  const tz = Session.getScriptTimeZone();
  const f = (d, patron) => Utilities.formatDate(d, tz, patron);
  const parrafo = (etiqueta, valor) => ({
    type: 'paragraph',
    content: [
      { type: 'text', text: etiqueta + ' ', marks: [{ type: 'strong' }] },
      { type: 'text', text: valor }
    ]
  });

  const fields = {
    project: { key: c.proyecto },
    summary: titulo,
    issuetype: { id: JIRA_TIPO_NO_CODE },
    labels: ['reunion'],
    duedate: f(inicio, 'yyyy-MM-dd'),                       // Fecha de vencimiento = día de la reunión
    customfield_10015: f(new Date(), 'yyyy-MM-dd'),         // Fecha de inicio = hoy
    customfield_12824: { id: c.workDomain }, // Work Domain
    description: {
      type: 'doc', version: 1,
      content: [
        parrafo('Fecha:', `${f(inicio, 'yyyy-MM-dd HH:mm')} - ${f(fin, 'HH:mm')}`),
        parrafo('Organizador:', solicitante || ''),
        parrafo('Invitados:', (invitados && invitados.length) ? invitados.join(', ') : 'Ninguno'),
        parrafo('Meet:', meetLink),
        parrafo('Evento:', eventoLink)
      ]
    }
  };

  // Asignar a quien solicitó la reunión
  try {
    const accountId = jiraAccountId(solicitante);
    if (accountId) fields.assignee = { accountId };
    else console.error('No encontré en Jira al usuario ' + solicitante);
  } catch (e) { console.error('Buscar usuario Jira: ' + e.message); }

  const issue = jira('/issue', 'post', { fields });

  // Mover a "In Progress"
  try {
    const { transitions } = jira(`/issue/${issue.key}/transitions`);
    const t = transitions.find(x => JIRA_ESTADO_DESTINO.test(x.to.name) || JIRA_ESTADO_DESTINO.test(x.name));
    if (t) jira(`/issue/${issue.key}/transitions`, 'post', { transition: { id: t.id } });
    else console.error('Transiciones disponibles: ' + transitions.map(x => `${x.name} → ${x.to.name}`).join(', '));
  } catch (e) { console.error('Transición Jira: ' + e.message); }

  return issue.key;
}


/**
 * Ejecuta esta función desde el editor para ver los valores permitidos
 * del campo obligatorio "Work Domain" (customfield_12824) y sus IDs.
 */
function verValoresWorkDomain() {
  const c = cfgJira();
  const base = `/issue/createmeta/${c.proyecto}/issuetypes`;
  const campos = jira(`${base}/${JIRA_TIPO_NO_CODE}?maxResults=200`);
  const campo = (campos.fields || campos.values || []).find(f => f.fieldId === 'customfield_12824');
  if (!campo) { Logger.log('No encontré el campo Work Domain'); return; }
  (campo.allowedValues || []).forEach(v => Logger.log(`ID: ${v.id}  →  ${v.value || v.name}`));
}

// ---------------- Configuración por usuario (/configurarjira) ----------------
function dialogoConfigJira(aviso) {
  const c = cfgJira();
  const widgets = [];
  if (aviso) widgets.push({ textParagraph: { text: aviso } });
  widgets.push(
    { textParagraph: { text: c.token
        ? '✅ Ya tienes Jira configurado. Deja el token vacío para conservar el actual.'
        : 'Crea tu token en <a href="https://id.atlassian.com/manage-profile/security/api-tokens">id.atlassian.com → Seguridad → Tokens de API</a>.' } },
    { textInput: { name: 'token', label: 'Token de API de Jira', type: 'SINGLE_LINE' } },
    { textInput: { name: 'proyecto', label: 'Clave del proyecto', value: c.proyecto || 'TECH' } },
    { textInput: { name: 'workDomain', label: 'ID de Work Domain', value: c.workDomain || '',
                   hintText: '15756 = Arquitectura' } },
    { buttonList: { buttons: [{ text: 'Guardar', onClick: { action: { function: 'guardarConfigJira' } } }] } }
  );
  return { action: { navigations: [{ pushCard: {
    header: { title: 'Configurar Jira', subtitle: 'Solo se guarda para tu usuario' },
    sections: [{ widgets }]
  } }] } };
}

function guardarConfigJira(event) {
  const inputs = (event.commonEventObject && event.commonEventObject.formInputs) || {};
  const valor = n => (inputs[n] && inputs[n].stringInputs && inputs[n].stringInputs.value[0] || '').trim();
  const email = (event.chat && event.chat.user && event.chat.user.email) || Session.getActiveUser().getEmail();
  const actual = cfgJira();
  const token = valor('token') || actual.token;
  const proyecto = valor('proyecto').toUpperCase();
  const workDomain = valor('workDomain');

  if (!token) return dialogoConfigJira('⚠️ Ingresa tu token de API.');

  // Validar el token contra Jira antes de guardarlo
  try {
    jira('/myself', 'get', null, { email, token });
  } catch (e) {
    return dialogoConfigJira('❌ Jira rechazó el token para ' + email + '. Revísalo e inténtalo de nuevo.');
  }

  const u = PropertiesService.getUserProperties();
  u.setProperties({ JIRA_EMAIL: email, JIRA_TOKEN: token });
  if (proyecto) u.setProperty('JIRA_PROJECT', proyecto);
  if (workDomain) u.setProperty('JIRA_WORK_DOMAIN_ID', workDomain);

  return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: {
    text: `✅ Jira configurado para ${email} (proyecto ${proyecto || actual.proyecto}). Ya puedes usar /generarmeet (o revisa con /status)`
  } } } } };
}


// ---------------- Formulario de /generarmeet ----------------
const DURACIONES = [15, 30, 45, 60, 90, 120];

function dialogoNuevaMeet(enChatCompartido, aviso, previo) {
  previo = previo || {};
  const tz = Session.getScriptTimeZone();

  // Hora por defecto: el próximo cuarto de hora (entre 06:00 y 21:45); si ya es tarde, mañana 09:00
  const ahora = new Date();
  let dia = ahora;
  let min = Math.ceil((parseInt(Utilities.formatDate(ahora, tz, 'H'), 10) * 60 +
                       parseInt(Utilities.formatDate(ahora, tz, 'm'), 10)) / 15) * 15;
  if (min < 6 * 60) min = 9 * 60;
  if (min > 21 * 60 + 45) { min = 9 * 60; dia = new Date(ahora.getTime() + 86400000); }
  const horaDefecto = previo.hora || `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const [y, m, d] = Utilities.formatDate(dia, tz, 'yyyy-MM-dd').split('-').map(Number);
  const fechaMs = previo.fechaMs || Date.UTC(y, m - 1, d);

  const horas = [];
  for (let t = 6 * 60; t <= 21 * 60 + 45; t += 15) {
    const h = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    horas.push({ text: h, value: h, selected: h === horaDefecto });
  }
  const durDefecto = String(previo.duracion || 30);

  const widgets = [];
  if (aviso) widgets.push({ textParagraph: { text: aviso } });
  widgets.push(
    { textInput: { name: 'titulo', label: 'Título de la reunión', value: previo.titulo || '' } },
    { dateTimePicker: { name: 'fecha', label: 'Fecha', type: 'DATE_ONLY', valueMsEpoch: Number(fechaMs) } },
    { selectionInput: { name: 'hora', label: 'Hora', type: 'DROPDOWN', items: horas } },
    { selectionInput: { name: 'duracion', label: 'Duración', type: 'DROPDOWN',
        items: DURACIONES.map(x => ({ text: x < 60 ? `${x} min` : `${x / 60} h`.replace('.5 h', ' h 30 min'),
                                      value: String(x), selected: String(x) === durDefecto })) } },
    // Buscador de personas de Dropi (escribe al menos 2 letras del nombre)
    { selectionInput: { name: 'personas', label: 'Invitados de Dropi (opcional)', type: 'MULTI_SELECT',
        multiSelectMaxSelectedItems: LIMITES.maxInvitados, multiSelectMinQueryLength: 2,
        platformDataSource: { commonDataSource: 'USER' } } },
    { textInput: { name: 'invitados', label: 'Correos externos (opcional)', value: previo.invitados || '',
        hintText: 'Separados por coma, por ejemplo cliente@empresa.com' } }
  );
  if (enChatCompartido) {
    widgets.push({ decoratedText: {
      text: 'Invitar a todos los miembros de este chat',
      bottomLabel: 'Se usa solo si no eliges invitados',
      switchControl: { name: 'todos', value: 'si', selected: previo.todos !== false }
    } });
  }
  widgets.push({ buttonList: { buttons: [{ text: 'Crear reunión',
    onClick: { action: { function: 'crearMeetDesdeDialogo' } } }] } });

  const card = { header: { title: 'Nueva reunión', subtitle: 'Meet + Calendar + tarea en Jira' }, sections: [{ widgets }] };
  return { action: { navigations: [aviso ? { updateCard: card } : { pushCard: card }] } };
}

function crearMeetDesdeDialogo(event) {
  const inputs = (event.commonEventObject && event.commonEventObject.formInputs) || {};
  const texto = n => (inputs[n] && inputs[n].stringInputs && inputs[n].stringInputs.value[0] || '').trim();
  const p = (event.chat && event.chat.buttonClickedPayload) || {};
  const espacio = p.space || null;
  const enChat = esChatCompartido(espacio);
  const solicitante = (event.chat && event.chat.user && event.chat.user.email) || '';

  const fi = inputs.fecha && (inputs.fecha.dateInput || inputs.fecha.dateTimeInput);
  const previo = {
    titulo: texto('titulo'), hora: texto('hora'), duracion: parseInt(texto('duracion'), 10) || 30,
    invitados: texto('invitados'), todos: !!inputs.todos,
    fechaMs: fi ? Number(fi.msSinceEpoch) : null
  };

  if (!previo.titulo) return dialogoNuevaMeet(enChat, '⚠️ Escribe un título.', previo);
  if (!previo.fechaMs || !previo.hora) return dialogoNuevaMeet(enChat, '⚠️ Elige la fecha y la hora.', previo);

  // La fecha llega como medianoche UTC del día elegido: se toman año/mes/día y se combina con la hora
  const f = new Date(previo.fechaMs);
  const fechaTxt = `${f.getUTCFullYear()}-${String(f.getUTCMonth() + 1).padStart(2, '0')}-${String(f.getUTCDate()).padStart(2, '0')}`;
  const inicio = new Date(`${fechaTxt}T${previo.hora}`);
  if (inicio.getTime() < Date.now() - 5 * 60000)
    return dialogoNuevaMeet(enChat, '⚠️ Esa fecha y hora ya pasaron. Elige una futura.', previo);

  // Invitados escritos: correos y @nombres
  const correos = [], nombres = [];
  previo.invitados.split(/[,;]+/).map(t => t.trim()).filter(Boolean).forEach(t => {
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) correos.push(t.toLowerCase());
    else nombres.push(t.replace(/^@/, '').trim());
  });

  // Personas elegidas en el buscador: llegan como "users/123..."
  const personas = (inputs.personas && inputs.personas.stringInputs && inputs.personas.stringInputs.value) || [];

  const resultado = crearReunion({
    titulo: previo.titulo, inicio, duracion: previo.duracion, correos, nombres,
    mencionesIds: personas, solicitante, espacio, sinMiembros: !previo.todos
  });

  return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: resultado } } } } };
}