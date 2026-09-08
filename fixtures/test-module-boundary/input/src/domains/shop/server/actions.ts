// Game code must not import a spec: `aruna test` compiles the spec, the game
// build does not, so this import would dangle in the built place (aruna::305).
import "./pricing.test";

export const nothing = 0;
