# Cerebro Translator for Obsidian

Plugin para Obsidian que traduce notas completas de inglés a español, creando una nueva nota traducida y respetando la estructura de Markdown, enlaces internos `[[...]]`, bloques de código y metadatos de frontmatter.

## Características

- Compatible con **iOS (iPhone y iPad)** y **macOS (Desktop)**.
- Motor de traducción web gratuito sin necesidad de API key ni registros.
- Soporte opcional para Google Gemini API (clave gratuita de Google AI Studio).
- Preserva la estructura de wikilinks `[[Nota]]` y `[[Nota|Alias]]` para no romper el grafo.
- Preserva bloques de código, código en línea y callouts.
- Opciones configurables para el nombre de la nota traducida (prefijo, título traducido, o ambos).
- Cumplimiento automático con la gobernanza de notas (`creada: AAAA-MM-DD` y `estado/sin-revisar`).

## Instalación con BRAT en Obsidian

1. Instalar el plugin **BRAT** desde la tienda de complementos de la comunidad de Obsidian.
2. Ir a **Ajustes > BRAT > Add Beta plugin**.
3. Ingresar: `juancandelario/cerebro-translator`
4. Pulsar en **Add Plugin**.
