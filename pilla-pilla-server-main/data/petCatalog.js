// Catálogo de especies para la Zona de Mascotas (Fase 5a).
//
// IMPORTANTE: mantener ids y precios EXACTAMENTE iguales a
// cliente_godot/autoload/pet_catalog.gd. Este archivo es la fuente de
// verdad real: el precio de adopción y el coste de entrenar salen de
// aquí, nunca del cliente.

const MAX_LEVEL = 10; // debe coincidir con PetCatalog.MAX_LEVEL en el cliente
const TRAIN_BASE_COST = 40; // debe coincidir con PetCatalog.TRAIN_BASE_COST en el cliente

const PET_SPECIES = [
  { id: 'chispi', name: 'Chispi', price: 0 },
  { id: 'brisa', name: 'Brisa', price: 300 },
  { id: 'rocoso', name: 'Rocoso', price: 500 },
  { id: 'lumen', name: 'Lumen', price: 900 },
];

function getSpecies(speciesId) {
  return PET_SPECIES.find((s) => s.id === speciesId) || null;
}

function trainingCost(level) {
  return TRAIN_BASE_COST * level;
}

function isMaxLevel(level) {
  return level >= MAX_LEVEL;
}

module.exports = { PET_SPECIES, MAX_LEVEL, getSpecies, trainingCost, isMaxLevel };
