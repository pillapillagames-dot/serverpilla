// Catálogo de gestos/emotes para la Tienda de Gestos (Fase 5a).
//
// IMPORTANTE: mantener ids y precios EXACTAMENTE iguales a
// cliente_godot/autoload/gesture_catalog.gd. Este archivo es la fuente de
// verdad real: el precio que se cobra al comprar sale de aquí, nunca del
// cliente.

const SLOT_COUNT = 4; // debe coincidir con GestureCatalog.SLOT_COUNT en el cliente

const GESTURE_CATALOG = [
  { id: 'saludo', name: 'Saludo', price: 0 },
  { id: 'reverencia', name: 'Reverencia', price: 200 },
  { id: 'baile', name: 'Baile', price: 250 },
  { id: 'burla', name: 'Burla', price: 300 },
  { id: 'ola_victoria', name: 'Ola de victoria', price: 350 },
];

function getGesture(gestureId) {
  return GESTURE_CATALOG.find((g) => g.id === gestureId) || null;
}

function isFree(gestureId) {
  const g = getGesture(gestureId);
  return !!g && g.price === 0;
}

module.exports = { GESTURE_CATALOG, SLOT_COUNT, getGesture, isFree };
