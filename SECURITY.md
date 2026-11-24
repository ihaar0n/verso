# Seguridad

## Informar de un fallo de seguridad

No abras un *issue* público para un fallo de seguridad, porque lo vería todo el mundo antes de que esté arreglado.

En su lugar, abre un **ticket privado** en nuestro servidor de Discord. Empieza el mensaje con **"Seguridad"** y explica:

- qué has encontrado y en qué versión de Verso;
- los pasos para reproducirlo;
- qué podría hacer alguien con ese fallo.

Respondemos en el ticket, lo arreglamos y publicamos una versión nueva en Releases.

## Cómo protege Verso tus datos

- Tu clave de API se guarda cifrada con el sistema de Windows (`safeStorage`) y nunca aparece en los informes de error.
- Las ventanas funcionan con `contextIsolation`, `sandbox` y sin acceso a Node.js. Además tienen una política de contenido (CSP) que solo permite código propio de la app.
- No se puede navegar a otras webs dentro de la app ni incrustar páginas. Los enlaces externos se abren en tu navegador, y la invitación de soporte solo acepta enlaces de `discord.gg` o `discord.com/invite`.
- Solo se conceden los permisos que la app usa: capturar el audio del sistema en el modo en vivo y copiar el informe al portapapeles.
- El instalador oficial se compila en GitHub Actions a partir de este repositorio y solo se publica aquí, en Releases.

## Versiones con soporte

Solo la última versión publicada en Releases recibe correcciones.

---

*English: please do not report security issues in public issues. Open a private ticket on our Discord server starting with "Security", and include the version, the steps to reproduce and the impact.*
