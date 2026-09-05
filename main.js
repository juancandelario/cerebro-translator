'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, MarkdownView, normalizePath } = require('obsidian');

const DEFAULT_SETTINGS = {
    engine: 'google_web', // 'google_web' | 'gemini'
    geminiApiKey: '',
    geminiModel: 'gemini-2.5-flash',
    targetLanguage: 'es',
    sourceLanguage: 'auto',
    fileNameMode: 'prefix', // 'prefix' | 'translated' | 'prefix_translated'
    filePrefix: '[ES] ',
    openAfterCreation: true,
    preserveWikilinks: true,
    preserveCodeBlocks: true
};

class CerebroTranslatorPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        // Icono en la barra lateral (Ribbon)
        this.addRibbonIcon('languages', 'Traducir nota actual al español (Cerebro)', async () => {
            await this.translateActiveNote();
        });

        // Comando en la paleta de comandos (apto para Mobile Toolbar en iPhone)
        this.addCommand({
            id: 'cerebro-translate-current-note',
            name: 'Traducir nota actual al español (nueva nota)',
            checkCallback: (checking) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'md') {
                    if (!checking) {
                        this.translateActiveNote();
                    }
                    return true;
                }
                return false;
            }
        });

        // Pestaña de ajustes
        this.addSettingTab(new CerebroTranslatorSettingTab(this.app, this));
    }

    onunload() {
        // Limpieza de recursos al desactivar
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Flujo principal de traducción de la nota activa
     */
    async translateActiveNote() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') {
            new Notice('No hay ninguna nota de Markdown activa para traducir.');
            return;
        }

        const notice = new Notice('Iniciando traducción al español...', 0);

        try {
            const rawContent = await this.app.vault.read(activeFile);
            if (!rawContent || rawContent.trim().length === 0) {
                notice.hide();
                new Notice('La nota activa está vacía.');
                return;
            }

            // 1. Separar Frontmatter YAML y Cuerpo
            const { frontmatter, body } = this.extractFrontmatter(rawContent);

            // 2. Procesar y traducir el cuerpo
            let translatedBody = '';
            if (this.settings.engine === 'gemini' && this.settings.geminiApiKey) {
                notice.setMessage('Traduciendo con Google Gemini...');
                translatedBody = await this.translateWithGemini(body);
            } else {
                notice.setMessage('Traduciendo con Google Translate...');
                translatedBody = await this.translateWithGoogleWeb(body);
            }

            // 3. Generar nuevo Frontmatter bajo gobernanza Codici
            const updatedFrontmatter = this.generateCodiciFrontmatter(frontmatter);

            // 4. Ensamblar contenido final
            const finalContent = updatedFrontmatter ? `${updatedFrontmatter}\n\n${translatedBody.trim()}\n` : `${translatedBody.trim()}\n`;

            // 5. Determinar nombre y ruta del nuevo archivo
            const parentDir = activeFile.parent ? activeFile.parent.path : '';
            let titleToUse = activeFile.basename;

            if (this.settings.fileNameMode === 'translated' || this.settings.fileNameMode === 'prefix_translated') {
                try {
                    notice.setMessage('Traduciendo título de la nota...');
                    let translatedTitle = '';
                    if (this.settings.engine === 'gemini' && this.settings.geminiApiKey) {
                        translatedTitle = await this.translateWithGemini(activeFile.basename);
                    } else {
                        translatedTitle = await this.requestGoogleTranslateChunk(activeFile.basename);
                    }
                    translatedTitle = translatedTitle
                        .replace(/[\r\n\t]/g, ' ')
                        .replace(/[\\/:*?"<>|]/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (translatedTitle.length > 0) {
                        titleToUse = translatedTitle;
                    }
                } catch (e) {
                    console.warn('No se pudo traducir el título del archivo, usando nombre original:', e);
                }
            }

            let newBaseName = '';
            if (this.settings.fileNameMode === 'translated') {
                newBaseName = titleToUse;
            } else {
                newBaseName = `${this.settings.filePrefix}${titleToUse}`;
            }

            let newFilePath = parentDir ? normalizePath(`${parentDir}/${newBaseName}.md`) : normalizePath(`${newBaseName}.md`);

            // Evitar sobrescribir si ya existe
            let counter = 1;
            while (await this.app.vault.adapter.exists(newFilePath)) {
                const suffixedName = `${newBaseName} (${counter})`;
                newFilePath = parentDir ? normalizePath(`${parentDir}/${suffixedName}.md`) : normalizePath(`${suffixedName}.md`);
                counter++;
            }

            // 6. Crear archivo en el vault
            const createdFile = await this.app.vault.create(newFilePath, finalContent);

            notice.hide();
            new Notice(`Nota traducida creada: ${createdFile.name}`, 6000);

            // 7. Abrir la nueva nota si está configurado
            if (this.settings.openAfterCreation) {
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(createdFile);
            }

        } catch (error) {
            notice.hide();
            console.error('Error en Cerebro Translator:', error);
            new Notice(`Error al traducir: ${error.message}`, 8000);
        }
    }

    /**
     * Separa el bloque YAML inicial del cuerpo de la nota
     */
    extractFrontmatter(content) {
        const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
        const match = content.match(fmRegex);
        if (match) {
            return {
                frontmatter: match[1],
                body: content.slice(match[0].length)
            };
        }
        return {
            frontmatter: null,
            body: content
        };
    }

    /**
     * Construye o actualiza el Frontmatter garantizando:
     * - creada: AAAA-MM-DD (fecha actual)
     * - estado/sin-revisar en tags
     */
    generateCodiciFrontmatter(originalFrontmatter) {
        const today = new Date().toISOString().slice(0, 10);

        if (!originalFrontmatter) {
            return `---\ncreada: ${today}\ntags:\n  - estado/sin-revisar\n---`;
        }

        let lines = originalFrontmatter.split(/\r?\n/);
        let hasCreada = false;
        let hasTags = false;
        let inTagsBlock = false;
        let hasSinRevisar = false;

        let newLines = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            // Manejo de fecha de creación (en notas nuevas traducidas nace con la fecha de hoy)
            if (/^creada:\s*/i.test(line)) {
                hasCreada = true;
                newLines.push(`creada: ${today}`);
                continue;
            }

            // Detectar bloque de tags
            if (/^tags:\s*$/i.test(line)) {
                hasTags = true;
                inTagsBlock = true;
                newLines.push(line);
                continue;
            }

            // Si tags está en formato en línea: tags: [foo, bar]
            if (/^tags:\s*\[(.*)\]/i.test(line)) {
                hasTags = true;
                let tagsContent = line.match(/^tags:\s*\[(.*)\]/i)[1];
                let tagsList = tagsContent.split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                // Reemplazar estado/revisado por estado/sin-revisar
                tagsList = tagsList.filter(t => t !== 'estado/revisado');
                if (!tagsList.includes('estado/sin-revisar')) {
                    tagsList.push('estado/sin-revisar');
                }
                newLines.push(`tags:\n` + tagsList.map(t => `  - ${t}`).join('\n'));
                continue;
            }

            // Dentro del bloque tags:
            if (inTagsBlock) {
                if (/^\s*-\s*(.+)/.test(line)) {
                    let tagVal = line.match(/^\s*-\s*(.+)/)[1].trim().replace(/^['"]|['"]$/g, '');
                    if (tagVal === 'estado/revisado') {
                        line = '  - estado/sin-revisar';
                        hasSinRevisar = true;
                    } else if (tagVal === 'estado/sin-revisar') {
                        hasSinRevisar = true;
                    }
                    newLines.push(line);
                    continue;
                } else if (/^\S/.test(line)) {
                    // Salió del bloque de tags
                    if (!hasSinRevisar) {
                        newLines.push('  - estado/sin-revisar');
                        hasSinRevisar = true;
                    }
                    inTagsBlock = false;
                }
            }

            newLines.push(line);
        }

        // Si terminó el archivo y seguía en bloque de tags sin haber añadido sin-revisar
        if (inTagsBlock && !hasSinRevisar) {
            newLines.push('  - estado/sin-revisar');
        }

        // Si no tenía tags
        if (!hasTags) {
            newLines.push('tags:\n  - estado/sin-revisar');
        }

        // Si no tenía creada
        if (!hasCreada) {
            newLines.unshift(`creada: ${today}`);
        }

        return `---\n${newLines.join('\n').trim()}\n---`;
    }

    /**
     * Traducción mediante el endpoint móvil gratuito de Google Translate
     * Protege enlaces [[...]], bloques de código, código en línea y callouts
     */
    async translateWithGoogleWeb(markdownText) {
        if (!markdownText || markdownText.trim().length === 0) return '';

        // 1. Reemplazo de sintaxis protegida por tokens alfanuméricos únicos
        const tokenMap = new Map();
        let tokenCounter = 0;

        const addToken = (original, prefix) => {
            const token = `XYZ${prefix}${tokenCounter}XYZ`;
            tokenMap.set(token, original);
            tokenCounter++;
            return token;
        };

        let protectedText = markdownText;

        // Proteger bloques de código con triple backtick
        if (this.settings.preserveCodeBlocks) {
            protectedText = protectedText.replace(/```[\s\S]*?```/g, (match) => addToken(match, 'CODEBLOCK'));
            // Proteger código en línea
            protectedText = protectedText.replace(/`[^`\n]+`/g, (match) => addToken(match, 'INLINECODE'));
        }

        // Proteger encabezados de callouts: > [!NOTE], > [!TIP], etc.
        protectedText = protectedText.replace(/>\s*\[![a-zA-Z0-9_-]+\]/g, (match) => addToken(match, 'CALLOUT'));

        // Proteger wikilinks de Obsidian: [[Nota]] o [[Nota|Alias]]
        if (this.settings.preserveWikilinks) {
            protectedText = protectedText.replace(/\[\[[^\]\n]+\]\]/g, (match) => addToken(match, 'WIKILINK'));
        }

        // Proteger URLs en enlaces Markdown: [texto visible](https://...) -> [texto visible](XYZURL0XYZ)
        protectedText = protectedText.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, (match, linkText, url) => {
            const urlToken = addToken(url, 'URL');
            return `[${linkText}](${urlToken})`;
        });

        // 2. Dividir en chunks para evitar límites de tamaño en peticiones URL
        const chunks = this.splitIntoChunks(protectedText, 2200);
        const translatedChunks = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (!chunk.trim()) {
                translatedChunks.push(chunk);
                continue;
            }

            const translatedChunk = await this.requestGoogleTranslateChunk(chunk);
            translatedChunks.push(translatedChunk);

            // Pausa breve entre fragmentos para cortesía con el servicio
            if (i < chunks.length - 1) {
                await this.sleep(150);
            }
        }

        let combined = translatedChunks.join('\n\n');

        // 3. Restaurar todos los tokens originales
        for (const [token, original] of tokenMap.entries()) {
            // Se usa expresión regular con bandera 'gi' por si Google Translate modificó mayúsculas
            const regex = new RegExp(token, 'gi');
            combined = combined.replace(regex, original);
        }

        return combined;
    }

    /**
     * Realiza una petición GET al endpoint móvil de Google Translate
     */
    async requestGoogleTranslateChunk(text) {
        const sl = this.settings.sourceLanguage || 'auto';
        const tl = this.settings.targetLanguage || 'es';
        const url = `https://translate.google.com/m?sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;

        const response = await requestUrl({
            url: url,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
            }
        });

        if (response.status !== 200) {
            throw new Error(`Google Translate devolvió el estado HTTP ${response.status}`);
        }

        const html = response.text;
        return this.parseGoogleResponse(html);
    }

    /**
     * Extrae el texto traducido del HTML devuelto por Google
     */
    parseGoogleResponse(html) {
        // 1. Usar DOMParser si está disponible en el entorno de Obsidian (desktop o móvil)
        if (typeof DOMParser !== 'undefined') {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const resultEl = doc.querySelector('.result-container');
            if (resultEl) {
                return resultEl.textContent || '';
            }
        }

        // 2. Fallback mediante expresión regular y decodificación manual
        const match = html.match(/<div class="result-container">([\s\S]*?)<\/div>/);
        if (match) {
            return this.unescapeHtml(match[1]);
        }

        throw new Error('No se encontró el texto traducido en la respuesta de Google.');
    }

    /**
     * Decodifica entidades HTML básicas
     */
    unescapeHtml(safe) {
        return safe
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ');
    }

    /**
     * Divide el texto por párrafos agrupándolos hasta alcanzar el límite máximo
     */
    splitIntoChunks(text, maxChunkSize = 2200) {
        const paragraphs = text.split(/\n\n+/);
        const chunks = [];
        let currentChunk = '';

        for (const p of paragraphs) {
            if (!currentChunk) {
                currentChunk = p;
            } else if ((currentChunk.length + p.length + 2) <= maxChunkSize) {
                currentChunk += '\n\n' + p;
            } else {
                chunks.push(currentChunk);
                currentChunk = p;
            }
        }

        if (currentChunk) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    /**
     * Traducción opcional mediante la API oficial de Google Gemini
     */
    async translateWithGemini(markdownText) {
        const apiKey = this.settings.geminiApiKey;
        const model = this.settings.geminiModel || 'gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

        const prompt = `Actúa como un traductor académico y profesional de alto nivel. Traduce la siguiente nota de Markdown del inglés al español.
Reglas obligatorias:
1. Mantén intactos todos los encabezados Markdown (#, ##, etc.), listas, bloques de citas y callouts.
2. Mantén intactos todos los enlaces internos [[...]] y las URLs [texto](url).
3. Mantén intactos todos los bloques de código y código en línea.
4. El estilo en español debe ser riguroso, elegante y fluido.
5. Devuelve única y exclusivamente el texto traducido, sin notas explicativas ni bloques de código envolventes.

Texto a traducir:
${markdownText}`;

        const payload = {
            contents: [
                {
                    parts: [
                        { text: prompt }
                    ]
                }
            ]
        };

        const response = await requestUrl({
            url: url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (response.status !== 200) {
            throw new Error(`Gemini API devolvió el código ${response.status}: ${response.text}`);
        }

        const data = response.json;
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
            return data.candidates[0].content.parts[0].text;
        }

        throw new Error('La respuesta de Gemini no contiene el formato esperado.');
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Pestaña de configuración de Cerebro Translator
 */
class CerebroTranslatorSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Configuración de Cerebro Translator' });

        new Setting(containerEl)
            .setName('Motor de traducción')
            .setDesc('Elija entre Google Translate Web (gratuito, sin clave) o Google Gemini (requiere API Key gratuita).')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('google_web', 'Google Translate Web (Gratuito, sin clave)')
                    .addOption('gemini', 'Google Gemini API (Requiere API Key)')
                    .setValue(this.plugin.settings.engine)
                    .onChange(async (value) => {
                        this.plugin.settings.engine = value;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        if (this.plugin.settings.engine === 'gemini') {
            new Setting(containerEl)
                .setName('Clave de API de Google Gemini')
                .setDesc('Clave obtenida gratis en Google AI Studio (aistudio.google.com).')
                .addText(text => text
                    .setPlaceholder('AIzaSy...')
                    .setValue(this.plugin.settings.geminiApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.geminiApiKey = value.trim();
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Modelo de Gemini')
                .setDesc('Modelo a utilizar para la traducción.')
                .addDropdown(dropdown => {
                    dropdown
                        .addOption('gemini-2.5-flash', 'Gemini 2.5 Flash (Recomendado)')
                        .addOption('gemini-2.0-flash', 'Gemini 2.0 Flash')
                        .addOption('gemini-1.5-flash', 'Gemini 1.5 Flash')
                        .setValue(this.plugin.settings.geminiModel)
                        .onChange(async (value) => {
                            this.plugin.settings.geminiModel = value;
                            await this.plugin.saveSettings();
                        });
                });
        }

        new Setting(containerEl)
            .setName('Modo de nombre para la nota traducida')
            .setDesc('Elija cómo se nombrará el nuevo archivo creado.')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('prefix', 'Prefijo + Título original (ej. [ES] Original Title)')
                    .addOption('translated', 'Título traducido en español (ej. Título en español)')
                    .addOption('prefix_translated', 'Prefijo + Título traducido (ej. [ES] Título en español)')
                    .setValue(this.plugin.settings.fileNameMode || 'prefix')
                    .onChange(async (value) => {
                        this.plugin.settings.fileNameMode = value;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        if (this.plugin.settings.fileNameMode !== 'translated') {
            new Setting(containerEl)
                .setName('Prefijo para el nuevo archivo')
                .setDesc('Texto que se antepondrá al nombre del archivo para crear la nota traducida.')
                .addText(text => text
                    .setPlaceholder('[ES] ')
                    .setValue(this.plugin.settings.filePrefix)
                    .onChange(async (value) => {
                        this.plugin.settings.filePrefix = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName('Preservar enlaces [[...]] de Obsidian')
            .setDesc('Protege los enlaces internos y alias para que el traductor no modifique los nombres de notas de su Cerebro.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.preserveWikilinks)
                .onChange(async (value) => {
                    this.plugin.settings.preserveWikilinks = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Preservar bloques de código')
            .setDesc('Protege los fragmentos de código para que no sean alterados por la traducción.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.preserveCodeBlocks)
                .onChange(async (value) => {
                    this.plugin.settings.preserveCodeBlocks = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Abrir nota al finalizar')
            .setDesc('Abre inmediatamente la nueva nota traducida en el editor.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.openAfterCreation)
                .onChange(async (value) => {
                    this.plugin.settings.openAfterCreation = value;
                    await this.plugin.saveSettings();
                }));
    }
}

module.exports = CerebroTranslatorPlugin;
