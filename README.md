<p align="center"><img src="assets/icon.png" width="96" alt="Verso"></p>

# Verso

Abres una canción, un vídeo o cualquier audio y Verso te enseña la **letra sincronizada** con lo que suena, **traducida línea a línea**. También pone **subtítulos flotantes** encima de cualquier ventana y puede traducir **en directo** lo que suena en tu PC.

App para **Windows 10 y 11**, en español e inglés.

*English: Verso shows synced, line-by-line translated lyrics for any song or audio on Windows, with floating subtitles and live translation. The app is available in English and Spanish.*

## Descargar

1. Ve a [**Releases**](../../releases/latest) y descarga `Verso-Setup-x.y.z.exe`.
2. Ábrelo e instala. Como la app es nueva y no está firmada, Windows puede mostrar "Windows protegió su PC": pulsa **Más información → Ejecutar de todas formas**.
3. Al abrir Verso, elige **Español** o **English**.

Descarga Verso solo desde este repositorio. Si te pasan el instalador por otro sitio, no lo abras.

## Primeros pasos

Para buscar letras no hace falta nada más. Para **transcribir y traducir** necesitas una clave gratuita de Groq:

1. Entra en <https://console.groq.com/keys> y pulsa **Create API Key**.
2. En Verso: **Ajustes → Traducción e IA**, pega la clave y pulsa **Probar conexión**.

## Qué hace

- **Letra sincronizada** desde [LRCLIB](https://lrclib.net) (gratis). Si la letra no tiene tiempos, Verso escucha el audio y la sincroniza palabra a palabra.
- **Transcripción con IA** cuando no hay letra: podcasts, entrevistas, vídeos…
- **Traducción precisa:** traduce con la canción entera como contexto, una segunda IA revisa cada línea y tú puedes corregir cualquiera con doble clic.
- **Original, traducción o las dos** a la vez.
- **Subtítulos flotantes** siempre visibles, con atajo global `Ctrl + Shift + S`.
- **Modo en vivo:** traduce lo que suena en el PC.
- **Para practicar:** velocidad de 0,5× a 1,25× sin cambiar el tono y repetir una línea con `R`.
- **Exportar** subtítulos `.srt` y letras `.lrc`.
- **Personalización:** tres temas, cinco colores, tamaño y alineación de la letra, y aspecto de los subtítulos.

Formatos: MP3, M4A, AAC, WAV, FLAC, OGG, OPUS, WEBM, MP4, MOV y más.

## ¿Algo no funciona?

Cuando hay un error, el aviso trae el botón **Reportar** (también en **Ayuda → Reportar un problema**):

1. **Copia el informe.** Lleva el error y datos técnicos. Tu clave y tus archivos nunca van en él.
2. **Entra en nuestro servidor de Discord.**
3. **Abre un ticket con MAX** y pega el informe.

## Privacidad y seguridad

- **Sin cuentas ni telemetría.** Verso no envía nada a ningún servidor propio.
- **Solo se conecta a:** LRCLIB (para las letras), el servicio de IA que elijas (Groq u OpenAI) para transcribir y traducir, y Ollama si lo usas en tu PC. A la IA solo se envían el audio que pides transcribir y el texto que traduce.
- **Tu clave de API se guarda cifrada** con el sistema de Windows, solo en tu PC.
- La app funciona aislada (Electron con `contextIsolation`, `sandbox` y una política de contenido estricta): no puede abrir webs dentro de la app ni ejecutar código externo.
- El instalador lo genera GitHub Actions directamente desde este código (ver `.github/workflows`).

Si encuentras un fallo de seguridad, lee [SECURITY.md](SECURITY.md).

## Desde el código

Requiere [Node.js LTS](https://nodejs.org).

```
npm install
npm start        # abrir la app
npm run dist     # crear el instalador en dist/
```

También puedes hacer doble clic en `Iniciar Verso.bat`.

Estructura: `main.js` (proceso principal), `preload.js` (puente seguro), `lib/` (letras, IA, alineación, subtítulos, soporte y almacenamiento) y `src/` (interfaz, idiomas y ventana flotante). La invitación de Discord para el soporte se configura en `soporte.json`.

## Licencia

[MIT](LICENSE) © 2026 ax¡d. Las fuentes Bricolage Grotesque y Crimson Pro tienen licencia SIL Open Font License (están en `src/fonts`).
