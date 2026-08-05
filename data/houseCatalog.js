// Catálogo de muebles/decoración para Casas de Jugadores (Fase 5a).
//
// IMPORTANTE: mantener ids y precios EXACTAMENTE iguales a
// cliente_godot/autoload/house_catalog.gd. Este archivo es la fuente de
// verdad real: el precio que se cobra al comprar sale de aquí, nunca del
// cliente.

const HOUSE_CATALOG = [
  { id: 'sofa_basico', name: 'Sofá básico', category: 'muebles', price: 0 },
  { id: 'sofa_lujo', name: 'Sofá de lujo', category: 'muebles', price: 800 },
  { id: 'mesa_centro', name: 'Mesa de centro', category: 'muebles', price: 150 },
  { id: 'estanteria', name: 'Estantería', category: 'muebles', price: 300 },
  { id: 'cama', name: 'Cama', category: 'muebles', price: 500 },
  { id: 'armario_ropa', name: 'Armario ropero', category: 'muebles', price: 450 },
  { id: 'nevera', name: 'Nevera', category: 'muebles', price: 400 },
  { id: 'fogones', name: 'Fogones', category: 'muebles', price: 350 },
  { id: 'banera', name: 'Bañera', category: 'muebles', price: 600 },
  { id: 'planta', name: 'Planta decorativa', category: 'decoracion', price: 100 },
  { id: 'alfombra', name: 'Alfombra', category: 'decoracion', price: 200 },
  { id: 'lampara', name: 'Lámpara de pie', category: 'decoracion', price: 250 },
  { id: 'cuadro', name: 'Cuadro de pared', category: 'decoracion', price: 180 },
  // Especiales: gratis, no pasan por /buy (el servidor las ignora si llegan ahí).
  { id: 'vitrina_trofeos', name: 'Vitrina de trofeos', category: 'especial', price: 0 },
  { id: 'estante_coleccion', name: 'Estante de colección', category: 'especial', price: 0 },
];

function getCatalogItem(itemId) {
  return HOUSE_CATALOG.find((item) => item.id === itemId) || null;
}

module.exports = { HOUSE_CATALOG, getCatalogItem };
