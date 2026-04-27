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
  } catch {
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
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  const res = await fetch(`https://id.twitch.tv/oauth2/token?${params.toString()}`, {
    method: 'POST'
  });

  if (!res.ok) {
    throw new Error(`No se pudo obtener token de Twitch: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function twitchGet(token, endpoint, query = {}) {
  const url = new URL(`https://api.twitch.tv/helix/${endpoint}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  const res = await fetch(url, {
    headers: {
      'Client-Id': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!res.ok) {
    throw new Error(`Error Twitch ${endpoint}: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function getSchedule(token) {
  const data = await twitchGet(token, 'schedule', {
    broadcaster_id: TWITCH_BROADCASTER_ID,
    first: '25'
  });
  return data.data?.segments ?? [];
}

async function getGameCoverBuffer(token, categoryId) {
  if (!categoryId) return null;
  const games = await twitchGet(token, 'games', { id: String(categoryId) });
  const game = games.data?.[0];
  const art = sanitizeBoxArtUrl(game?.box_art_url);
  if (!art) return null;
  const imgRes = await fetch(art);
  if (!imgRes.ok) return null;
  const arrayBuffer = await imgRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function buildDescription(segment) {
  const parts = [DEFAULT_EVENT_DESCRIPTION];
  if (segment.title) parts.push(`Título en Twitch: ${segment.title}`);
  if (segment.is_recurring) parts.push('Evento recurrente en Twitch');
  return parts.join('\n');
}

function buildEventName(segment) {
  return segment.title?.trim() || 'Próximo stream';
}

async function syncSchedule(client) {
  console.log(`[SYNC] Iniciando ${new Date().toISOString()}`);
  const token = await getTwitchAppToken();
  const segments = await getSchedule(token);
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const existingEvents = await guild.scheduledEvents.fetch();
  const store = loadStore();
  const activeSegmentIds = new Set();

  for (const segment of segments) {
    if (segment.canceled_until) continue;
    activeSegmentIds.add(segment.id);

    const imageBuffer = await getGameCoverBuffer(token, segment.category);
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

    if (mappedEventId && existingEvents.has(mappedEventId)) {
      const event = existingEvents.get(mappedEventId);
      await event.edit(payload, 'Sincronizado desde Twitch');
      console.log(`[SYNC] Actualizado evento ${event.id} para segmento ${segment.id}`);
    } else {
      const created = await guild.scheduledEvents.create(payload);
      store.mappings[segment.id] = created.id;
      console.log(`[SYNC] Creado evento ${created.id} para segmento ${segment.id}`);
    }
  }

  for (const [segmentId, eventId] of Object.entries(store.mappings)) {
    if (activeSegmentIds.has(segmentId)) continue;
    const event = existingEvents.get(eventId) || await guild.scheduledEvents.fetch(eventId).catch(() => null);
    if (event) {
      await event.delete('El segmento ya no existe en Twitch');
      console.log(`[SYNC] Eliminado evento ${eventId} porque ya no existe en Twitch`);
    }
    delete store.mappings[segmentId];
  }

  saveStore(store);
  console.log('[SYNC] Finalizado');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
  console.log(`Bot listo como ${client.user.tag}`);
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
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
  }

  await syncSchedule(client).catch(err => console.error('[SYNC ERROR inicial]', err));
  setInterval(() => {
    syncSchedule(client).catch(err => console.error('[SYNC ERROR intervalo]', err));
  }, Number(SYNC_INTERVAL_MINUTES) * 60 * 1000);
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

client.login(DISCORD_TOKEN);
