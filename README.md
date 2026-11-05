# kyara-bot

Bot Node.js pour ouvrir les packs gratuits sur kyara.games.

## Installation sur Android (Termux)

```sh
pkg update && pkg upgrade -y
pkg install nodejs git
git clone https://github.com/Nexusdev-3276/kyara-bot.git
cd kyara-bot
npm install
```

## Lancement

```sh
KYARA_TOKEN=ton_token ONCE=1 node kyara-bot.mjs
```

Pour le 24/7, utilise tmux et termux-wake-lock (voir README complet).
