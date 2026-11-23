#!/usr/bin/env python3
"""
Genera el icono oficial de la app: el logo SAIME al medio, sobre el azul de la
guia, con "Tramites" en letras blancas arriba.

Por que existe este script
--------------------------
El icono sale de una sola imagen de origen, scripts/icono-saime-fuente.jpg: el
logo SAIME (la caja azul con las letras y la cinta tricolor con las estrellas).
Esa imagen viene con un fondo blanco en la parte de abajo, el triangulo que se
ve a los lados de la cinta. El script quita SOLO ese blanco:

  1. marca los pixeles casi blancos,
  2. rellena desde el borde de la imagen (asi solo cae el blanco de afuera y no
     las letras ni las estrellas, que quedan encerradas por el azul),
  3. come un par de pixeles del filo para que no quede una linea blanca.

Despues arma el bloque "Tramites" + logo y lo pone al medio del cuadro azul.
El azul es el de la guia, #2961B4, el mismo que va en manifest.json.

Los iconos "maskable" son los que Android recorta con su propia forma (circulo,
gota, cuadrado redondeado). Por eso el bloque se dibuja mas chico: todo lo
importante tiene que caber en el 80% central o Android lo corta.

Uso:  python3 scripts/make-icon.py
Salida: public/icon-1024.png, icon-512.png, icon-192.png,
        icon-maskable-512.png, icon-maskable-192.png,
        apple-touch-icon.png, favicon-32.png
"""
import os
import sys
from collections import deque

from PIL import Image, ImageDraw, ImageFont, ImageFilter

AQUI = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(AQUI, '..', 'public')
FUENTE = os.path.join(AQUI, 'icono-saime-fuente.jpg')
LETRA = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'

AZUL = (41, 97, 180)      # #2961B4, el azul de la guia
TEXTO = 'Tramites'        # se dibuja con acento mas abajo
TEXTO = 'Tr\u00e1mites'

BLANCO_MIN = 215          # desde que tono se considera blanco de fondo
LOGO_ANCHO = 2200         # ancho del logo dentro del bloque maestro
MARGEN_X = 100            # aire a los lados del bloque
GAP = 110                 # separacion entre el texto y el logo

ESCALA_NORMAL = 0.94      # cuanto del cuadro ocupa el bloque
ESCALA_SEGURA = 0.72      # version maskable


def logo_sin_blanco():
    """Devuelve el logo recortado con el fondo blanco de abajo hecho transparencia."""
    if not os.path.exists(FUENTE):
        sys.exit('Falta la imagen de origen: ' + FUENTE)
    im = Image.open(FUENTE).convert('RGB')
    px = im.load()
    w, h = im.size

    def blanco(x, y):
        r, g, b = px[x, y]
        return r >= BLANCO_MIN and g >= BLANCO_MIN and b >= BLANCO_MIN

    # Relleno desde el borde: cae el blanco de afuera, no el de las letras.
    fuera = [[False] * w for _ in range(h)]
    cola = deque()

    def sembrar(x, y):
        if blanco(x, y) and not fuera[y][x]:
            fuera[y][x] = True
            cola.append((x, y))

    for x in range(w):
        sembrar(x, 0)
        sembrar(x, h - 1)
    for y in range(h):
        sembrar(0, y)
        sembrar(w - 1, y)

    while cola:
        x, y = cola.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not fuera[ny][nx] and blanco(nx, ny):
                fuera[ny][nx] = True
                cola.append((nx, ny))

    # Un par de pasadas comiendo el filo claro que deja el JPEG.
    for _ in range(2):
        matar = []
        for y in range(h):
            for x in range(w):
                if fuera[y][x]:
                    continue
                r, g, b = px[x, y]
                if min(r, g, b) < 185:
                    continue
                vecino = ((x > 0 and fuera[y][x - 1]) or (x < w - 1 and fuera[y][x + 1]) or
                          (y > 0 and fuera[y - 1][x]) or (y < h - 1 and fuera[y + 1][x]))
                if vecino:
                    matar.append((x, y))
        for x, y in matar:
            fuera[y][x] = True

    salida = im.convert('RGBA')
    datos = salida.load()
    for y in range(h):
        for x in range(w):
            if fuera[y][x]:
                datos[x, y] = (0, 0, 0, 0)
    return salida.crop(salida.getchannel('A').getbbox() or (0, 0, w, h))


def bloque_maestro(logo):
    """Arma el bloque con 'Tramites' arriba y el logo debajo."""
    alto_logo = int(logo.height * LOGO_ANCHO / logo.width)
    ancho = LOGO_ANCHO + MARGEN_X * 2

    objetivo = LOGO_ANCHO * 0.92
    tam = 100
    for _ in range(40):
        f = ImageFont.truetype(LETRA, tam)
        caja = f.getbbox(TEXTO)
        if caja[2] - caja[0] >= objetivo:
            break
        tam = int(tam * 1.06)
    f = ImageFont.truetype(LETRA, tam)
    caja = f.getbbox(TEXTO)
    alto_texto = caja[3] - caja[1]

    img = Image.new('RGBA', (ancho, alto_texto + GAP + alto_logo), (0, 0, 0, 0))

    tx = (ancho - (caja[2] - caja[0])) // 2 - caja[0]
    ty = -caja[1]
    sombra = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sombra).text((tx, ty + 8), TEXTO, font=f, fill=(0, 0, 0, 90))
    img.alpha_composite(sombra.filter(ImageFilter.GaussianBlur(10)))
    ImageDraw.Draw(img).text((tx, ty), TEXTO, font=f, fill=(255, 255, 255, 255))

    img.alpha_composite(logo.resize((LOGO_ANCHO, alto_logo), Image.LANCZOS),
                        ((ancho - LOGO_ANCHO) // 2, alto_texto + GAP))
    return img


def solo_logo(logo, size):
    """El favicon va sin texto: a 32 px la palabra no se lee, estorba."""
    lienzo = Image.new('RGB', (size, size), AZUL)
    caja = int(size * 0.94)
    k = min(caja / logo.width, caja / logo.height)
    w = max(1, int(logo.width * k))
    h = max(1, int(logo.height * k))
    pieza = logo.resize((w, h), Image.LANCZOS)
    lienzo.paste(pieza, ((size - w) // 2, (size - h) // 2), pieza)
    return lienzo


def icono(bloque, size, escala):
    """Pone el bloque al medio del cuadro azul."""
    lienzo = Image.new('RGB', (size, size), AZUL)
    caja = size * escala
    k = min(caja / bloque.width, caja / bloque.height)
    w = max(1, int(bloque.width * k))
    h = max(1, int(bloque.height * k))
    pieza = bloque.resize((w, h), Image.LANCZOS)
    lienzo.paste(pieza, ((size - w) // 2, (size - h) // 2), pieza)
    return lienzo


def main():
    logo = logo_sin_blanco()
    bloque = bloque_maestro(logo)

    salidas = {
        'icon-1024.png': icono(bloque, 1024, ESCALA_NORMAL),
        'icon-512.png': icono(bloque, 512, ESCALA_NORMAL),
        'icon-192.png': icono(bloque, 192, ESCALA_NORMAL),
        'favicon-32.png': solo_logo(logo, 32),
        'icon-maskable-512.png': icono(bloque, 512, ESCALA_SEGURA),
        'icon-maskable-192.png': icono(bloque, 192, ESCALA_SEGURA),
        'apple-touch-icon.png': icono(bloque, 180, ESCALA_NORMAL),
    }

    for nombre, imagen in salidas.items():
        destino = os.path.join(PUBLIC, nombre)
        imagen.save(destino, optimize=True)
        print('escrito %s (%dx%d)' % (nombre, imagen.width, imagen.height))

    print('Listo. Recuerda subir tambien la version de cache en index.html, '
          'manifest.json y sw.js para que el cambio llegue a los telefonos.')


if __name__ == '__main__':
    main()
