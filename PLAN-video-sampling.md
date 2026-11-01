# Plan: recorte y muestreo visual del vídeo al crear una tarea

Fecha: 2026-11-02 · Fork: `NoelDNathan/cvat` · Rama propuesta: `feat/video-sampling`

## 0. Objetivo

Al subir un vídeo en «Create a new task», ver el vídeo, **elegir el tramo** (inicio y fin), **elegir el muestreo**
(cada cuántos fotogramas) y ver **en vivo cuántos fotogramas tendrá la tarea**, antes de crearla. Hoy eso ya se puede
hacer, pero a ciegas: son tres números sueltos (`Start frame`, `Stop frame`, `Frame step`) dentro de *Advanced
configuration*, que hay que calcular a mano.

| Fase | Contenido | ¿Cambia el backend? |
|---|---|---|
| **1 (este plan, en detalle)** | Bloque «Video sampling»: ficha técnica del vídeo, reproductor, barra de recorte con miniaturas, selector de muestreo, recuento en vivo y avisos. Sincronizado con los campos de *Advanced configuration* | No |
| 2 (esbozo §10) | Sugerir *Segment size*, estimar memoria, recordar el último muestreo, previsualizar los fotogramas resultantes | No |

### Reglas de diseño (no negociables)

1. **El formulario avanzado sigue siendo la fuente de verdad.** El bloque nuevo solo lee y escribe `startFrame`,
   `stopFrame` y `frameStep` de `AdvancedConfigurationForm`. Lo que llega al servidor es exactamente lo de hoy
   (`start_frame`, `stop_frame`, `frame_filter: "step=N"`), así que no hay API, migración ni formato nuevos.
2. **Cambio acotado.** Código nuevo en archivos nuevos; en archivos existentes, solo enganches mínimos (§3.2).
3. **Si no se puede, no estorba.** Vídeo de servidor/nube, varios archivos, formato no MP4 o códec que el navegador no
   reproduce: el bloque no aparece o se queda en «solo datos». Los campos de siempre siguen funcionando.
4. **Estilo de CVAT.** Textos de la UI y comentarios en inglés; antd (`Slider` con `range`, `Segmented`, `Alert`); SCSS
   con las variables de `base.scss`.

## 1. Qué hay ya en CVAT (revisado para no duplicar)

| Qué | Dónde | Conclusión |
|---|---|---|
| Campos de rango y paso | `advanced-configuration-form.tsx:360-387` (`startFrame`, `stopFrame`, `frameStep`), pintados en `:566-575` | **Reutilizar.** El bloque nuevo los rellena |
| Paso a `frame_filter` | `advanced-configuration-form.tsx:212-219` (`step=${frameStep}`) | Reutilizar sin cambios |
| Envío al servidor | `actions/tasks-actions.ts:240-247` | Sin cambios. Ojo: `if (startFrame)` ignora `0`, que es correcto porque `0` es el valor por defecto |
| Validación de `stop ≥ start` | `validateStopFrame` en `advanced-configuration-form.tsx:176` | Reutilizar (se dispara al hacer `setFieldsValue` + `validateFields`) |
| Fórmula de fotogramas resultantes | `models.py:530` `get_valid_frame_indices = range(start, stop + 1, step)` | La UI usa la misma: `floor((stop − start) / step) + 1`. **`stop_frame` es inclusivo** |
| Recorte del `stop` en el servidor | `task.py:2043-2048`: si `stop` se pasa del final, se ajusta al último fotograma | Un `stop` algo alto no rompe nada |
| Detección de tipo de archivo | `utils/files.ts:9` `getFileContentType(file)` | Reutilizar para saber si el archivo local es vídeo |
| Vista previa de vídeo, miniaturas, `<video>` | Ninguna en `cvat-ui/src` (búsqueda de `<video`, `HTMLVideoElement`, `createObjectURL`, `thumbnail`, `trim`, `sampl`) | **No existe nada.** Tampoco en la creación de tareas de audio (`audio/components/create-task-page/`) |
| Parser MP4 | `cvat-data/src/ts/3rdparty/mp4.js` (Broadway) | **No reutilizar.** Necesita el archivo entero en memoria (`new Bytestream(buffer)`, línea 839), es antiguo y está pensado para los chunks que manda el servidor. Para un vídeo de partido de varios GB no sirve |
| Librería MP4 en `node_modules` (`mp4box`, etc.) | No hay ninguna | Se escribe un lector mínimo de cajas MP4 (§2.2), ~150 líneas sin dependencias |

## 2. Comportamiento de la fase 1

### 2.1 Cuándo aparece

Solo si se cumplen todas:

- Creación de **una** tarea (no `many`).
- Pestaña **My computer** (`activeFileManagerTab === 'local'`).
- Entre los archivos locales (sin contar `.jsonl`) hay **exactamente un vídeo**.

Si el usuario cambia de archivo, se descarta el estado anterior (URL del objeto, miniaturas, lectura en curso) y se
vuelve a empezar. Si se quita el vídeo, el bloque desaparece y **no** se tocan los campos avanzados.

### 2.2 Ficha técnica (lector MP4)

`mp4-info.ts` lee solo las cajas necesarias usando `Blob.slice`, sin cargar el archivo entero (funciona aunque `moov`
esté al final del archivo):

- `moov/mvhd`: duración total.
- El `trak` cuyo `mdia/hdlr` es `vide`:
  - `tkhd`: ancho y alto.
  - `mdia/mdhd`: `timescale`.
  - `minf/stbl/stts`: **número de muestras (fotogramas)** y duraciones. `fps = timescale / delta`; si hay más de un
    `delta` distinto, se marca como **VFR**.
  - `minf/stbl/stsd`: códec (`avc1`/`avc3`/`hvc1`/`hev1`/…) y, para H.264, `avcC` → `profile_idc`, compatibilidad y
    nivel. `profile_idc` 110 = **High 10**, es decir, 10 bits.
- `edts/elst`: si hay una lista de edición que recorta el inicio, se anota (riesgo §9).

Con esos datos se muestra una línea como esta, que además responde a «¿qué formato tengo?»:

```
1920×1080 · 29.97 fps · 1799 frames · 1:00.03 · H.264 High 10 (10-bit)
```

Para archivos que no son MP4/MOV (`.avi`, `.mkv`, `.webm`) la fase 1 no lee la ficha: el bloque muestra «Preview not
available for this format» y deja los campos de siempre.

### 2.3 ¿Se puede previsualizar?

Con los datos de `avcC` se construye la cadena exacta del códec (p. ej. `avc1.6E0028` para High 10) y se pregunta
`video.canPlayType('video/mp4; codecs="…"')`. Si devuelve `''`, el bloque pasa a **modo solo datos**: ficha técnica,
recorte por números (con la barra pero sin miniaturas) y recuento. En ese caso se muestra este aviso:

> This video is 10-bit H.264, which browsers can't preview and which is slow to decode on the server.
> Converting it to 8-bit is recommended: `ffmpeg -i in.mp4 -vf format=yuv420p -c:v libx264 -crf 20 out.mp4`

### 2.4 Disposición

```
┌ Video sampling ──────────────────────────────────────────────────────────────┐
│ 1920×1080 · 29.97 fps · 1799 frames · 1:00.03 · H.264 High (8-bit)           │
│ ┌──────────────────────────────────────────────┐                             │
│ │                 <video>                      │  frame 361 · 0:12.04         │
│ └──────────────────────────────────────────────┘                             │
│ ▕█▌[mini][mini][mini][mini][mini][mini][mini][mini][mini][mini][mini]▐█▏     │
│   ↑ asa inicio (360)                                 asa fin (1739) ↑        │
│ Sampling: [All 29.97] [15 fps] [10 fps] [5 fps] [1 fps] [Custom: step __]    │
│ Output: 0:12.01 → 0:58.02 (46.0 s) · every 3rd frame (≈ 9.99 fps) · 460 frames│
│ ⚠ Below 5 fps: fine for detection, too sparse for tracking IDs               │
└──────────────────────────────────────────────────────────────────────────────┘
```

Va **entre «Select files» y «Advanced configuration»**, en una `Col span={24}` como el resto de bloques.

### 2.5 Interacciones

- **Asas del recorte** (`Slider range` de antd, en fotogramas, `min = 0`, `max = frameCount − 1`): al moverlas, el
  `<video>` salta a ese fotograma para ver dónde se corta. La tira de miniaturas va detrás del slider, como fondo.
- **Clic en una miniatura**: lleva el reproductor a ese instante (no mueve las asas).
- **Botones «Set start here» y «Set end here»**, junto al reproductor: ponen el asa en el fotograma actual del vídeo.
  Es la forma precisa de cortar justo cuando empieza la jugada.
- **Muestreo** (`Segmented`): las opciones en fps de salida se traducen a paso entero:
  `step = max(1, round(fps / target))`. Se muestran el fps real resultante (`fps / step`) y el paso. «Custom» deja
  escribir el paso a mano. Si un preset da el mismo paso que otro, se oculta.
- **Recuento**: `frames = floor((stop − start) / step) + 1`, la misma fórmula que el servidor (§1).
- **Avisos** (`Alert` en línea, sin bloquear el envío):
  - fps de salida < 5 → «too sparse for tracking IDs».
  - Más de 3000 fotogramas resultantes → sugerir *Segment size* (en la fase 2 habrá un botón que lo rellene).
  - VFR → «Variable frame rate: frame numbers are approximate».
  - 10 bits → aviso de §2.3.

### 2.6 Sincronización con *Advanced configuration*

Los dos sentidos:

- **Bloque → formulario**: cada cambio llama a `advancedForm.setFrameRange({ startFrame, stopFrame, frameStep })`
  (método público nuevo, §3.2). Si el rango es el vídeo entero y el paso es 1, se dejan los campos **vacíos** (como hoy),
  no `0 / 1798 / 1`.
- **Formulario → bloque**: si el usuario escribe en los campos, el formulario avisa con `onChangeFrameRange` y el bloque
  mueve las asas y el selector. Así no hay dos verdades.

Detalle importante: el `Collapse` de *Advanced configuration* **no monta el formulario hasta que se abre**, y al enviar,
si `advancedConfigurationComponent.current` es `null`, se usa `state.advanced` (`create-task-content.tsx:457` y
`:497`). Si se abriera después, el formulario nacería vacío y al enviarse **borraría** el recorte. Solución: poner
`forceRender: true` en ese item del `Collapse`, para que el formulario exista siempre y sea la única fuente de verdad.

### 2.7 Miniaturas

- Un `<video>` oculto, con la misma URL de objeto (`URL.createObjectURL(file)`), `muted` y `preload='auto'`.
- N = `clamp(round(anchoTira / 96), 8, 24)` miniaturas repartidas a lo largo del vídeo **entero** (no del recorte),
  para poder mover las asas sobre ellas.
- Se generan **una a una** (seek → `seeked` → `drawImage` en un canvas de 96 px de alto → `toBlob`) y se pintan según
  llegan. Si cambia el archivo o se desmonta el bloque, se cancela con un `AbortController`.
- Al desmontar, `URL.revokeObjectURL` de la URL del vídeo y de cada miniatura.
- Coste estimado: 50–150 ms por *seek* en 1080p → menos de 3 s para 20 miniaturas, en segundo plano.

### 2.8 Qué NO hace la fase 1

No recorta ni recodifica el vídeo en el navegador (se sube entero, como hoy). No admite varios cortes por tarea (CVAT
solo tiene un rango por tarea). No funciona con *Connected file share*, URLs remotas ni almacenamiento en la nube. No
toca la creación múltiple (`many`) ni la de audio.

## 3. Archivos

### 3.1 Nuevos

| Archivo | Contenido |
|---|---|
| `cvat-ui/src/utils/video-sampling.ts` | Lógica pura, **sin imports**: presets de fps → paso, recuento, segundos ↔ fotograma, formato de tiempo, avisos, «¿rango completo?» |
| `cvat-ui/src/utils/video-sampling.test.ts` | Tests con `node:test` (§5.1) |
| `cvat-ui/src/utils/mp4-info.ts` | Lector de cajas MP4, **sin imports**. Recibe `read(start, end) → Promise<Uint8Array>` para que se pueda probar en Node con un `Buffer` |
| `cvat-ui/src/utils/mp4-info.test.ts` | Tests con archivos de prueba (§5.1) |
| `cvat-ui/src/utils/__fixtures__/` | 3–4 MP4 diminutos (64×36, 10 fotogramas, < 10 KB cada uno), generados con ffmpeg (§5.1) |
| `cvat-ui/src/components/create-task-page/video-sampling/video-sampling.tsx` | Bloque: ficha, reproductor, botones, selector, recuento y avisos |
| `…/video-sampling/range-filmstrip.tsx` | `Slider range` sobre la tira de miniaturas |
| `…/video-sampling/use-video-info.ts` | Hook: URL del objeto, `readMp4Info(file)`, `canPlayType`, limpieza |
| `…/video-sampling/use-thumbnails.ts` | Hook: generación secuencial y cancelable de miniaturas |
| `…/video-sampling/styles.scss` | Estilos del bloque |

API de `video-sampling.ts`:

```ts
export interface FrameRange { startFrame: number; stopFrame: number; frameStep: number; } // stop inclusive
export interface SamplingPreset { key: string; label: string; step: number; outputFps: number; }

export function stepForTargetFps(fps: number, targetFps: number): number;      // max(1, round(fps / target))
export function samplingPresets(fps: number): SamplingPreset[];                 // sin pasos repetidos
export function countOutputFrames(range: FrameRange): number;                   // floor((stop − start) / step) + 1
export function frameToSeconds(frame: number, fps: number): number;
export function secondsToFrame(seconds: number, fps: number, frameCount: number): number; // recortado a [0, n−1]
export function formatTime(seconds: number): string;                            // m:ss.cc
export function isFullRange(range: FrameRange, frameCount: number): boolean;
export function samplingWarnings(info: { fps: number; vfr: boolean; bitDepth: number; width: number; height: number },
    range: FrameRange): SamplingWarning[];
```

API de `mp4-info.ts`:

```ts
export interface Mp4VideoInfo {
    width: number; height: number;
    timescale: number; durationSeconds: number;
    frameCount: number; fps: number; vfr: boolean;
    codec: string;          // 'avc1', 'hvc1', …
    codecString?: string;   // 'avc1.6E0028', para canPlayType
    profileName?: string;   // 'Baseline' | 'Main' | 'High' | 'High 10' | …
    bitDepth: number;       // 8 o 10, según el perfil
    editListOffsetFrames: number; // 0 si no hay elst que recorte
}
export async function readMp4Info(
    size: number, read: (start: number, end: number) => Promise<Uint8Array>,
): Promise<Mp4VideoInfo | null>; // null si no es MP4/MOV o no tiene pista de vídeo
```

### 3.2 Modificados (enganches mínimos)

| Archivo | Cambio |
|---|---|
| `create-task-page/advanced-configuration-form.tsx` | Método público `setFrameRange(range)` (`setFieldsValue` + `validateFields(['stopFrame'])`); prop opcional `onChangeFrameRange` llamada desde `onValuesChange` del `Form` cuando cambian `startFrame`, `stopFrame` o `frameStep` |
| `create-task-page/create-task-content.tsx` | `renderVideoSamplingBlock()` entre `renderFilesBlock()` y `renderAdvancedBlock()`; `forceRender: true` en el item del `Collapse` avanzado (§2.6); pasar `onChangeFrameRange`; `resetState` también limpia el bloque |

Nada más. Ni reducers, ni acciones, ni `cvat-core`, ni backend.

## 4. Datos y estado

- El estado del bloque (info, URL, miniaturas, rango y paso que se muestran) vive en el propio componente. El rango
  «oficial» es el del formulario (§2.6).
- `create-task-content` le pasa: el `File` de vídeo (o `null`), el rango actual del formulario y un callback
  `onChange(range)` que llama a `advancedConfigurationComponent.current.setFrameRange(range)`.
- Lectura MP4: `read = (s, e) => file.slice(s, e).arrayBuffer().then((b) => new Uint8Array(b))`. Lee cabeceras de 8–16
  bytes y salta cajas; solo carga entero `moov` (normalmente < 2 MB; si pasa de 64 MB se aborta y se pasa a modo solo
  datos).

## 5. Pruebas

### 5.1 Unitarias de la lógica pura

Igual que en el timeline: archivos sin imports ni `enum`, ejecutados con el *type stripping* de Node 24:

```bash
node --test cvat-ui/src/utils/video-sampling.test.ts cvat-ui/src/utils/mp4-info.test.ts
```

Archivos de prueba (se generan una vez y se suben al repo, con el comando anotado en un `README` dentro de la carpeta):

```bash
ffmpeg -f lavfi -i testsrc=size=64x36:rate=30000/1001 -frames:v 10 -pix_fmt yuv420p -c:v libx264 -profile:v high cfr-8bit.mp4
ffmpeg -f lavfi -i testsrc=size=64x36:rate=30000/1001 -frames:v 10 -pix_fmt yuv420p10le -c:v libx264 -profile:v high10 cfr-10bit.mp4
ffmpeg -f lavfi -i testsrc=size=64x36:rate=25 -frames:v 10 -pix_fmt yuv420p -c:v libx264 -movflags +faststart faststart.mp4
```

Casos mínimos:

1. `countOutputFrames`: `0..1798` paso 1 → 1799; `360..1739` paso 3 → 460; `start == stop` → 1; mismo resultado que
   `len(range(start, stop + 1, step))` en una tabla de casos.
2. `stepForTargetFps`: 29.97 → 15 = paso 2, 10 = paso 3, 5 = paso 6, 1 = paso 30; 25 fps → 10 = paso 3 (8.33 fps, más
   cerca de 10 que los 12.5 del paso 2); nunca menos de 1.
3. `samplingPresets` no repite pasos (con un vídeo de 10 fps, «15 fps» y «All» darían paso 1 → solo uno).
4. `secondsToFrame` / `frameToSeconds` ida y vuelta sin perder fotogramas en los bordes (0 y n−1).
5. `isFullRange` → los campos quedan vacíos.
6. `readMp4Info`: `cfr-8bit` → 64×36, 10 fotogramas, 29.97 fps, `High`, 8 bits, `avc1.64…`; `cfr-10bit` → `High 10`,
   10 bits, `avc1.6E…`; `faststart` → igual de bien con `moov` al principio; un archivo que no es MP4 → `null`; cajas
   truncadas → `null`, sin excepción.
7. `readMp4Info` sobre `parte1-1m30.mp4` (local, no se sube): 1920×1080, 1799 fotogramas, 29.97, High 10, igual que
   `ffprobe`.

### 5.2 Comprobación en el navegador (lista)

1. Subir un MP4 8 bits: aparecen la ficha, el reproductor y las miniaturas en < 3 s; la consola está limpia.
2. Mover las asas: el vídeo salta, el recuento cambia y los campos de *Advanced configuration* (abriéndolo) muestran lo
   mismo.
3. Escribir en los campos avanzados: las asas y el selector se mueven.
4. Crear la tarea con recorte y paso 3: en el job, el número de fotogramas es el que decía el bloque, y el primer y el
   último fotograma son los que se veían en las asas.
5. Crear sin tocar nada: la petición no lleva `start_frame`, `stop_frame` ni `frame_filter` (pestaña Network), igual que
   hoy.
6. Abrir *Advanced configuration* **después** de recortar y crear: el recorte se mantiene (§2.6).
7. Subir `parte1-1m30.mp4` (High 10): modo solo datos con el aviso de 10 bits; el recorte por números funciona.
8. Cambiar de vídeo a mitad de la generación de miniaturas: no se mezclan miniaturas y no hay errores.
9. Varios archivos, imágenes, pestaña de servidor o nube, `many` y audio: el bloque no aparece.
10. *Reset* del formulario tras crear: el bloque desaparece y no quedan URLs de objeto vivas.

### 5.3 Cypress (opcional, al final)

`tests/cypress/e2e/actions_tasks/case_XXX_video_sampling.js`: subir un vídeo de prueba, elegir 10 fps, crear y
comprobar el número de fotogramas del job. No bloquea la fase 1.

## 6. Bucle de desarrollo

Igual que en `PLAN-timeline-ids.md` §6 (webpack en `localhost:3000` contra el backend en `8080`, `lint` y
`ForkTsChecker`, `git -c safe.directory=…`).

**Antes de empezar:** la rama actual es `feat/track-timeline` y tiene cambios sin commitear en `canvas-layout.tsx`,
`track-timeline.tsx` y `use-timeline-rows.ts`. Hay que commitearlos o guardarlos con `stash` y crear
`feat/video-sampling` desde `develop`, para que las dos funciones vayan en ramas y PRs separados.

## 7. Pasos de implementación (en orden, un commit cada uno)

1. Crear la rama `feat/video-sampling` desde `develop` (tras dejar limpio `feat/track-timeline`).
2. `video-sampling.ts` + tests en verde.
3. Archivos de prueba MP4 + `mp4-info.ts` + tests en verde, incluido el caso del vídeo real (§5.1 punto 7).
4. Enganches del formulario: `setFrameRange`, `onChangeFrameRange` y `forceRender`. Comprobar §5.2 puntos 5 y 6 con un
   botón temporal que llame a `setFrameRange`.
5. `use-video-info.ts` + bloque con ficha, reproductor, selector y recuento (sin miniaturas). Comprobar §5.2 puntos 2,
   3, 4 y 7.
6. `use-thumbnails.ts` + `range-filmstrip.tsx`. Comprobar §5.2 puntos 1 y 8.
7. Botones «Set start/end here», avisos y pulido de estilos.
8. Pasar la lista §5.2 completa, lint y type-check; fragmento en `changelog.d/` si se quiere proponer upstream.

## 8. Rendimiento

- La lectura MP4 toca solo las cabeceras y `moov`; no lee los datos del vídeo.
- Un solo `<video>` oculto para las miniaturas; *seeks* en serie, nunca en paralelo.
- Miniaturas de 96 px de alto como `Blob`, no `dataURL` (menos memoria y sin cadenas enormes en React).
- El recuento y los avisos son aritmética: se recalculan en cada movimiento de asa sin coste.
- `setFrameRange` hacia el formulario con *throttle* de 100 ms mientras se arrastra.

## 9. Riesgos y cómo se cubren

| Riesgo | Mitigación |
|---|---|
| El número de fotogramas del navegador no coincide con el del servidor (que decodifica con PyAV) | Se usa el recuento de `stts` (el mismo que `nb_frames` de ffprobe); prueba §5.2 punto 4; el servidor recorta `stop` si se pasa (`task.py:2046`) |
| Lista de edición (`elst`) que recorta el inicio y desplaza la numeración | Se detecta y se muestra «frame numbers may be off by N»; caso raro en vídeos de cámara/móvil |
| VFR (móviles) | Aviso; el paso sigue siendo en fotogramas, que es lo que usa CVAT, así que el recuento es exacto aunque los tiempos no |
| El navegador no reproduce el códec (10 bits, HEVC sin soporte) | `canPlayType` con la cadena exacta → modo solo datos + aviso con el comando de ffmpeg |
| `moov` enorme o archivo corrupto | Límite de 64 MB y `try/catch` → modo solo datos o bloque oculto; nunca bloquea la creación |
| El formulario avanzado borra el recorte al abrirse tarde | `forceRender: true` (§2.6) + prueba §5.2 punto 6 |
| `job_file_mapping` no admite rango ni paso (`task.py:376-385`) | Ese modo solo se usa por API/CLI; si en la UI llegara a combinarse, el servidor ya devuelve el error |
| Conflictos al actualizar desde upstream | Código nuevo aislado; 2 archivos existentes con cambios pequeños |

## 10. Fases siguientes (esbozo)

- Botón «Split into jobs of N frames» que rellene *Segment size* según el recuento y la resolución.
- Estimación de memoria por job (fotogramas × ancho × alto × 4, con el límite de caché de `frames.ts:923`).
- Recordar el último muestreo elegido (`localStorage`) para el siguiente vídeo.
- Vista previa de los fotogramas resultantes (reproducir saltando de `step` en `step`).
- Ficha y recorte también para vídeos de *Connected file share*, pidiendo los metadatos al servidor.

## 11. Decisiones abiertas

| Decisión | Opciones | Recomendación |
|---|---|---|
| Presets de muestreo | fps de salida / «1 frame every N seconds» como en Roboflow | fps de salida, más «Custom step»; encaja mejor con seguimiento |
| Dónde va el bloque | entre archivos y avanzado / dentro de *Advanced configuration* | Entre ambos, siempre visible: es lo primero que se decide con un vídeo |
| Miniaturas sobre todo el vídeo o solo el recorte | todo / recorte | Todo el vídeo, para poder mover las asas sobre ellas |
| Formatos además de MP4/MOV | solo MP4/MOV / también WebM/MKV | Solo MP4/MOV en la fase 1 |
| Umbral del aviso de tracking | 5 fps / configurable | 5 fps fijo en la fase 1 |
| Commitear este plan | sí, en la rama / no | Sí, en `feat/video-sampling` como primer commit |
