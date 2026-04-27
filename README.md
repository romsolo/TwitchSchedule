# Twitch → Discord Schedule Sync Bot

Bot en Node.js para sincronizar tu calendario de Twitch con los eventos programados de Discord, incluyendo imagen de portada usando la categoría/juego de Twitch cuando exista.

## Qué hace
- Lee tu schedule de Twitch
- Crea eventos programados en Discord
- Actualiza eventos existentes si cambian hora, título o imagen
- Usa la portada de la categoría de Twitch como imagen del evento cuando esté disponible
- Omite segmentos cancelados
- Mantiene un mapeo local entre segmento de Twitch y evento de Discord

## Requisitos
- Node.js 20+
- Un bot de Discord con permisos de eventos
- Una app en Twitch Developers
- Un servidor en Render como Web Service

## Permisos recomendados del bot
- View Channels
- Send Messages (opcional)
- Create Events
- Manage Events

No le des Administrator.

## Variables de entorno
Copia `.env.example` a `.env` y llena los valores.

## Deploy en Render
1. Sube esta carpeta a GitHub.
2. En Render, elige **New Web Service**.
3. Conecta tu repo.
4. Configura las variables de entorno.
5. Deploy.

## Cómo funciona
- El bot obtiene un token app de Twitch.
- Consulta `Get Channel Stream Schedule`.
- Para cada segmento, busca su categoría y obtiene `box_art_url` si existe.
- Crea o actualiza el evento en Discord.
- Guarda el mapeo en `data-store.json`.

## Notas
- La persistencia en archivo sirve para MVP. Para producción conviene usar una DB simple.
- Render free puede reiniciar o dormir servicios; para empezar está bien.
