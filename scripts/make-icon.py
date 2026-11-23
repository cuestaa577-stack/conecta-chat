#!/usr/bin/env python3
"""
Genera el icono de la app a partir de la imagen de la bandera.

Por que existe este script
--------------------------
El icono ya no se dibuja con formas: sale de una sola imagen de origen, la
bandera en 3D con fondo transparente, que vive en scripts/icono-fuente.png.
Desde ahi se recorta la bandera, se compone sobre un fondo azul casi negro y
se reducen todos los tamanos. Al partir siempre de la misma fuente, el icono
queda igual en el telefono, en el navegador y en la pantalla de inicio.

El recorte no esta escrito a mano: se mide el area con contenido real de la
imagen (su canal alfa) y se le deja un margen parejo. Asi el script sigue
funcionando si algun dia cambias la imagen por otra mas grande o con mas aire.

Los iconos "maskable" son los que Android recorta con su propia forma (circulo,
gota, cuadrado redondeado). Por eso la bandera se dibuja mas pequena y centrada:
todo lo importante tiene que caber en el 80% central o Android lo corta.

Uso:  python3 scripts/make-icon.py
Salida: public/icon-1024.png, icon-512.png, icon-192.png,
        icon-maskable-512.png, icon-maskable-192.png,
        apple-touch-icon.png, favicon-32.png
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

AQUI = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(AQUI, '..', 'public')
FUENTE = os.path.join(AQUI, 'icono-fuente.png')

MARGEN = 6          # aire alrededor de la bandera al recortar (px de la fuente)
ANCHO_NORMAL = 0.94 # la bandera ocupa casi todo el ancho del icono
ANCHO_SEGURO = 0.72 # version maskable: cabe dentro del 80% central de Android

FONDO_ARRIBA = (11, 27, 51)   # azul muy oscuro
FONDO_ABAJO = (5, 9, 15)      # casi negro


def fondo(size):
    """Degradado vertical armado en una columna de 1 px y estirado al cuadro."""
    col = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        col.putpixel((0, y), tuple(
            int(FONDO_ARRIBA[i] + (FONDO_ABAJO[i] - FONDO_ARRIBA[i]) * t)
            for i in range(3)
        ))
    return col.resize((size, size))


def recortar_bandera():
    """Recorta la bandera usando el area con contenido de la imagen."""
    if not os.path.exists(FUENTE):
        sys.exit('Falta la imagen de origen: ' + FUENTE)
    im = Image.open(FUENTE).convert('RGBA')
    caja = im.getchannel('A').getbbox() or im.getbbox()
    if not caja:
        sys.exit('La imagen de origen esta vacia: ' + FUENTE)
    x0, y0, x1, y1 = caja
    x0 = max(0, x0 - MARGEN)
    y0 = max(0, y0 - MARGEN)
    x1 = min(im.width, x1 + MARGEN)
    y1 = min(im.height, y1 + MARGEN)
    return im.crop((x0, y0, x1, y1))


def hacer(size, ancho_bandera, bandera):
    lienzo = fondo(size).convert('RGBA')

    ancho = int(size * ancho_bandera)
    alto = int(bandera.height * ancho / bandera.width)
    x = (size - ancho) // 2
    y = (size - alto) // 2
    pieza = bandera.resize((ancho, alto), Image.LANCZOS)

    # Sombra suave debajo para que la bandera no parezca pegada al fondo.
    sombra = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(sombra)
    d.rounded_rectangle(
        [x + 2, y + int(alto * 0.06), x + ancho - 2, y + alto - int(alto * 0.02)],
        radius=max(2, int(size * 0.02)),
        fill=(0, 0, 0, 150),
    )
    sombra = sombra.filter(ImageFilter.GaussianBlur(max(2, size // 45)))

    lienzo.alpha_composite(sombra)
    lienzo.alpha_composite(pieza, (x, y))
    return lienzo.convert('RGB')


def main():
    bandera = recortar_bandera()

    salidas = {
        'icon-1024.png': hacer(1024, ANCHO_NORMAL, bandera),
        'icon-512.png': hacer(512, ANCHO_NORMAL, bandera),
        'icon-192.png': hacer(192, ANCHO_NORMAL, bandera),
        'icon-maskable-512.png': hacer(512, ANCHO_SEGURO, bandera),
        'icon-maskable-192.png': hacer(192, ANCHO_SEGURO, bandera),
        'apple-touch-icon.png': hacer(180, ANCHO_NORMAL, bandera),
        'favicon-32.png': hacer(32, ANCHO_NORMAL, bandera),
    }

    for nombre, imagen in salidas.items():
        destino = os.path.join(PUBLIC, nombre)
        imagen.save(destino, optimize=True)
        print('escrito %s (%dx%d)' % (nombre, imagen.width, imagen.height))

    print('Listo. Recuerda subir tambien la version de cache en index.html, '
          'manifest.json y sw.js para que el cambio llegue a los telefonos.')


if __name__ == '__main__':
    main()
