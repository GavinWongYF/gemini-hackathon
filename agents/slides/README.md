# Pitch slides

One web page holds the pitch slides and the live game, so the talk can switch between them with one key and the game never reloads.

## Run it

1. Start the game: `npm run dev` in `client/` (port 5173).
2. Start the agent server (see `agents/docs/running.md`).
3. Start the slides: `node agents/slides/serve.mjs`
4. Open `http://localhost:8766/deck/index.html?game=/match` in Chrome.

Arrow keys or space move through the slides. **G** switches to the game and back. The game loads the first time you press G, so its match starts then.

## Racket and camera

In the game view, the buttons in the bottom left corner connect the racket over Bluetooth (or a USB cable), zero it, and turn the camera on. They call the game's own input code, so the game needs no change.

## How it works

`serve.mjs` serves the slides at `/deck/` and passes every other request on to the game, whose address is the one line in `game-address.txt`. Slides and game then share one address, which is what lets the slide page hear G inside the game and reach the game's racket and camera code.

The video clips the slides play are not in the repo. Put them in `web/media/`.
