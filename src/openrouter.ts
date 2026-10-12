// Compatibility re-exports: the speech providers live in src/central/speech/.
export { OpenRouter, OpenRouterError, OPENROUTER_BASE_URL, type OpenRouterOptions } from "./central/speech/openrouter"
export { audioFormat, SpeechError, type SpeechProvider } from "./central/speech/provider"
