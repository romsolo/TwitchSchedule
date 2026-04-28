import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Client,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionsBitField
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storePath = path.join(__dirname, '..', 'data-store.json');

const {
  DISCORD_TOKEN,
  DISCORD_GUILD_ID,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_BROADCASTER_ID,
  SYNC_INTERVAL_MINUTES = '10',
  PORT = '10000',
  TIMEZONE = 'America/Mexico_City',
  EVENT_LOCATION = 'Twitch',
  DEFAULT_EVENT_DESCRIPTION = 'Próximo stream programado desde Twitch'
} = process.env;

const requiredEnv = [
  'DISCORD_TOKEN',
  'DISCORD_GUILD_ID',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'TWITCH_BROADCASTER_ID'
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Falta variable de entorno: ${key}`);
  }
}

function loadStore() {
  if (!fs.existsSync(storePath)) return { mappings: {} };
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (err) {
    console.error('[STORE] Error leyendo store, se usará vacío', err);
    return { mappings: {} };
  }
}

function saveStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function sanitizeBoxArtUrl(url) {
  if (!url) return null;
  return url.replace('{width}', '512').replace('{height}', '680');
}

async function getTwitchAppToken() {
  console.log('[TWITCH] Solicitando app token');
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  const res = await fetch(`https://id.twitch.tv/oauth2/token?${params.toString()}`, {
    method: 'POST'
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`No se pudo obtener token de Twitch: ${res.status} ${body}`);
  }

  const data = await res.json();
  console.log('[TWITCH] App token obtenido correctamente');
  return data.access_token;
}

async function twitchGet(token, endpoint, query = {}) {
  const url = new URL(`https://api.twitch.tv/helix/${endpoint}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  console.log(`[TWITCH] GET ${endpoint} -> ${url.toString()}`);
  const res = await fetch(url, {
    headers: {
      'Client-Id': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Error Twitch ${endpoint}: ${res.status} ${body}`);
  }

  const json = await res.json();
  console.log(`[TWITCH] OK ${endpoint}`);
  return json;
}

async function getSchedule(token) {
  const data = await twitchGet(token, 'schedule', {
    broadcaster_id: TWITCH_BROADCASTER_ID,
    first: '25'
  });
  const segments = data.data?.segments ?? [];
  console.log(`[TWITCH] Segmentos obtenidos: ${segments.length}`);
  if (segments[0]) {
    console.log('[TWITCH] Ejemplo de segmento:', JSON.stringify(segments[0], null, 2));
  }
  return segments;
}

async function getGameCoverBuffer(token, categoryId) {
  if (!categoryId) {
    console.log('[TWITCH] Segmento sin category/category_id, no se cargará imagen');
    return null;
  }
  console.log(`[TWITCH] Buscando portada de categoría ${categoryId}`);
  const games = await twitchGet(token, 'games', { id: String(categoryId) });
  const game = games.data?.[0];
  const art = sanitizeBoxArtUrl(game?.box_art_url);
  console.log('[TWITCH] Juego encontrado:', game?.name || '(sin nombre)', 'art:', art || '(sin art)');
  if (!art) return null;
  const imgRes = await fetch(art);
  if (!imgRes.ok) {
    console.warn(`[TWITCH] No se pudo descargar box art: ${imgRes.status}`);
    return null;
  }
  const arrayBuffer = await imgRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log(`[TWITCH] Imagen descargada (${buffer.length} bytes)`);
  return buffer;
}

function buildDescription(segment) {
  const parts = [DEFAULT_EVENT_DESCRIPTION];
  if (segment.title) parts.push(`Título en Twitch: ${segment.title}`);
  if (segment.is_recurring) parts.push('Evento recurrente en Twitch');
  if (segment.category_name) parts.push(`Categoría: ${segment.category_name}`);
  return parts.join('\n');
}

function buildEventName(segment) {
  return segment.title?.trim() || 'Próximo stream';
}

async function syncSchedule(client) {
  console.log(`\n[SYNC] Iniciando ${new Date().toISOString()}`);
  const token = await getTwitchAppToken();
  const segments = await getSchedule(token);
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  console.log(`[DISCORD] Guild obtenido: ${guild.name} (${guild.id})`);
  const existingEvents = await guild.scheduledEvents.fetch();
  console.log(`[DISCORD] Eventos existentes: ${existingEvents.size}`);
  const store = loadStore();
  const activeSegmentIds = new Set();

  for (const segment of segments) {
    console.log(`[SYNC] Procesando segmento ${segment.id} | ${segment.title || '(sin título)'}`);
    if (segment.canceled_until) {
      console.log(`[SYNC] Segmento ${segment.id} cancelado, se omite`);
      continue;
    }

    activeSegmentIds.add(segment.id);

    const categoryId = segment.category_id || segment.category?.id || segment.category;
    const imageBuffer = await getGameCoverBuffer(token, categoryId).catch(err => {
      console.error('[TWITCH IMAGE ERROR]', err);
      return null;
    });

    const start = new Date(segment.start_time);
    const end = segment.end_time ? new Date(segment.end_time) : new Date(start.getTime() + 2 * 60 * 60 * 1000);
    const mappedEventId = store.mappings[segment.id];

    const payload = {
      name: buildEventName(segment),
      scheduledStartTime: start,
      scheduledEndTime: end,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: EVENT_LOCATION },
      description: buildDescription(segment)
    };

    if (imageBuffer) payload.image = imageBuffer;

    console.log('[DISCORD] Payload a crear/editar:', {
      name: payload.name,
      start: payload.scheduledStartTime,
      end: payload.scheduledEndTime,
      location: payload.entityMetadata.location,
      hasImage: Boolean(payload.image)
    });

    if (mappedEventId && existingEvents.has(mappedEventId)) {
      const event = existingEvents.get(mappedEventId);
      try {
        await event.edit(payload, 'Sincronizado desde Twitch');
        console.log(`[SYNC] Actualizado evento ${event.id} para segmento ${segment.id}`);
      } catch (err) {
        console.error(`[DISCORD EDIT ERROR] segmento ${segment.id}`, err);
      }
    } else {
      try {
        const created = await guild.scheduledEvents.create(payload);
        store.mappings[segment.id] = created.id;
        console.log(`[SYNC] Creado evento ${created.id} para segmento ${segment.id}`);
      } catch (err) {
        console.error(`[DISCORD CREATE ERROR] segmento ${segment.id}`, err);
      }
    }
  }

  for (const [segmentId, eventId] of Object.entries(store.mappings)) {
    if (activeSegmentIds.has(segmentId)) continue;
    try {
      const event = existingEvents.get(eventId) || await guild.scheduledEvents.fetch(eventId).catch(() => null);
      if (event) {
        await event.delete('El segmento ya no existe en Twitch');
        console.log(`[SYNC] Eliminado evento ${eventId} porque ya no existe en Twitch`);
      }
      delete store.mappings[segmentId];
    } catch (err) {
      console.error(`[DISCORD DELETE ERROR] segmento ${segmentId}`, err);
    }
  }

  saveStore(store);
  console.log('[SYNC] Finalizado');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

process.on('unhandledRejection', (error) => {
  console.error('[UNHANDLED REJECTION]', error);
});

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
});

client.on('debug', (msg) => {
  console.log('[DISCORD DEBUG]', msg);
});

client.on('warn', (msg) => {
  console.warn('[DISCORD WARN]', msg);
});

client.on('error', (err) => {
  console.error('[DISCORD CLIENT ERROR]', err);
});

client.on('shardError', (err, shardId) => {
  console.error(`[DISCORD SHARD ERROR] shard ${shardId}`, err);
});

client.on('shardDisconnect', (event, shardId) => {
  console.warn(`[DISCORD SHARD DISCONNECT] shard ${shardId}`, event?.code, event?.reason || '');
});

client.on('shardReconnecting', (shardId) => {
  console.warn(`[DISCORD SHARD RECONNECTING] shard ${shardId}`);
});

client.on('shardResume', (shardId, replayed) => {
  console.log(`[DISCORD SHARD RESUME] shard ${shardId}, replayed ${replayed}`);
});

client.on('shardReady', (shardId) => {
  console.log(`[DISCORD SHARD READY] shard ${shardId}`);
});

client.once('ready', async () => {
  console.log(`Bot listo como ${client.user.tag}`);
  try {
    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    console.log(`[DISCORD] Guild fetch ok: ${guild.name} (${guild.id})`);
    const me = await guild.members.fetchMe();
    const perms = me.permissions;
    const needed = [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.CreateEvents,
      PermissionsBitField.Flags.ManageEvents
    ];
    const missing = needed.filter(p => !perms.has(p));
    if (missing.length) {
      console.warn('Faltan permisos en Discord para operar correctamente:', missing);
    } else {
      console.log('[DISCORD] Permisos necesarios OK');
    }

    await syncSchedule(client).catch(err => console.error('[SYNC ERROR inicial]', err));
    setInterval(() => {
      syncSchedule(client).catch(err => console.error('[SYNC ERROR intervalo]', err));
    }, Number(SYNC_INTERVAL_MINUTES) * 60 * 1000);
  } catch (err) {
    console.error('[READY HANDLER ERROR]', err);
  }
});

const app = express();
app.get('/', (_req, res) => {
  res.send('twitch-discord-sync online');
});
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), timezone: TIMEZONE });
});
app.listen(Number(PORT), () => {
  console.log(`HTTP server escuchando en puerto ${PORT}`);
});

console.log('[BOOT] DISCORD_TOKEN presente:', Boolean(DISCORD_TOKEN), 'longitud:', DISCORD_TOKEN?.length || 0);
console.log('[BOOT] DISCORD_GUILD_ID:', DISCORD_GUILD_ID);
console.log('[BOOT] TWITCH_BROADCASTER_ID:', TWITCH_BROADCASTER_ID);
console.log('[BOOT] SYNC_INTERVAL_MINUTES:', SYNC_INTERVAL_MINUTES);
client.login((DISCORD_TOKEN || '').trim()).then(() => {
  console.log('[DISCORD LOGIN] login() resolved');
}).catch(err => {
  console.error('[DISCORD LOGIN ERROR]', err);
});
