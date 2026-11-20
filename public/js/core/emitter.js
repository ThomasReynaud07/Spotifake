/**
 * Petit émetteur d'événements, base des modèles (Library, Player, Network).
 * `on()` retourne une fonction de désabonnement.
 */
export class Emitter {
  #listeners = new Map();

  on(event, listener) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(listener);
    return () => this.#listeners.get(event)?.delete(listener);
  }

  emit(event, ...args) {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[Emitter] erreur dans un listener « ${event} »`, error);
      }
    }
  }
}
