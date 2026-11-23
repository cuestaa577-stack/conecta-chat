#!/usr/bin/env python3
"""
Genera el icono oficial de la app: el logo SAIME al medio, sobre el azul de la
guia, con "Tramites" en letras blancas arriba.

Por que existe este script
--------------------------
El icono sale de una sola imagen de origen, scripts/icono-saime-fuente.jpg: el
logo SAIME (la caja azul con las letras y la cinta tricolor con las estrellas).
Esa imagen trae dos fondos que no van en el icono:

  1. El blanco de abajo, el triangulo que se ve a los lados de la cinta.
  2. La caja azul de atras, que sobre el azul de la app se veia como un
     recuadro oscuro. El icono tiene que quedar solo con las letras SAIME y
     la cinta, flotando sobre el azul.

Los dos se sacan igual: se marca la zona por color y se rellena desde un borde
conocido. Asi solo cae el fondo y quedan intactas las letras y las estrellas,
que estan encerradas por otros colores.

  - El blanco se rellena desde el borde de la imagen.
  - La caja azul se rellena desde arriba y desde los costados, antes de que
    empiece la cinta: el azul de la cinta no se toca porque queda aislado por
    las franjas amarilla y roja.

El filo que queda entre las letras y la caja se recompone sobre el azul nuevo,
si no quedaria un halo oscuro alrededor de cada letra.

Uso:  python3 scripts/make-icon.py
Salida: public/icon-1024.png, icon-512.png, icon-192.png,
        icon-maskable-512.png, icon-maskable-192.png,
        apple-touch-icon.png, favicon-32.png
"""
import os
import sys
from collections import deque

from PIL import Image, ImageDraw, ImageFilter, ImageFont

AQUI = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(AQUI, '..', 'public')
FUENTE = os.path.join(AQUI, 'icono-saime-fuente.jpg')
LETRA = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'

AZUL = (41, 97, 180)      # #2961B4, el azul de la guia
TEXTO = 'Tr\u00e1mites'
SALUDO = 'Bienvenidos'    # linea chiquita de arriba

BLANCO_MIN = 215          # desde que tono se considera blanco de fondo
LOGO_ANCHO = 2200         # ancho del logo dentro del bloque maestro
MARGEN_X = 100            # aire a los lados del bloque
GAP = 170                 # aire entre "Tramites" y el logo
GAP_LINEAS = 26           # aire entre "Bienvenidos" y "Tramites"
SALUDO_REL = 0.56         # que tan grande va "Bienvenidos" frente a "Tramites"
FIT = 1.02                # ancho del texto frente al ancho del logo

ESCALA_NORMAL = 0.94      # cuanto del cuadro ocupa el bloque
ESCALA_SEGURA = 0.72      # version maskable


def rellenar(mascara, semillas):
    """Devuelve los pixeles de la mascara alcanzables desde las semillas."""
    alto = len(mascara)
    ancho = len(mascara[0])
    visto = [[False] * ancho for _ in range(alto)]
    cola = deque()
    for x, y in semillas:
        if 0 <= x < ancho and 0 <= y < alto and mascara[y][x] and not visto[y][x]:
            visto[y][x] = True
            cola.append((x, y))
    while cola:
        x, y = cola.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < ancho and 0 <= ny < alto and mascara[ny][nx] and not visto[ny][nx]:
                visto[ny][nx] = True
                cola.append((nx, ny))
    return visto


def logo_limpio():
    """Saca el blanco de afuera y la caja azul: deja letras y cinta."""
    if not os.path.exists(FUENTE):
        sys.exit('Falta la imagen de origen: ' + FUENTE)
    im = Image.open(FUENTE).convert('RGB')
    px = im.load()
    ancho, alto = im.size

    def es_blanco(x, y):
        r, g, b = px[x, y]
        return r >= BLANCO_MIN and g >= BLANCO_MIN and b >= BLANCO_MIN

    def es_caja(x, y):
        r, g, b = px[x, y]
        return b > r + 12 and b > g + 6 and 110 < b < 235

    # 1) el blanco de afuera, rellenando desde todo el borde
    blanco = [[es_blanco(x, y) for x in range(ancho)] for y in range(alto)]
    semillas = []
    for x in range(ancho):
        semillas += [(x, 0), (x, alto - 1)]
    for y in range(alto):
        semillas += [(0, y), (ancho - 1, y)]
    fuera = rellenar(blanco, semillas)

    # 2) la caja azul, rellenando desde arriba y los costados (por encima de la
    #    cinta) para no comerse el azul de la bandera
    caja = [[es_caja(x, y) for x in range(ancho)] for y in range(alto)]
    semillas = []
    for x in range(ancho):
        semillas += [(x, y) for y in range(0, int(alto * 0.55), 3)]
    for y in range(0, int(alto * 0.55), 3):
        semillas += [(0, y), (ancho - 1, y)]
    dentro = rellenar(caja, semillas)

    # 3) el filo claro entre las letras y la caja: se recompone sobre el azul
    #    nuevo para que no quede un halo oscuro alrededor de cada letra
    zona = Image.new('L', (ancho, alto), 0)
    zpx = zona.load()
    for y in range(alto):
        for x in range(ancho):
            if dentro[y][x]:
                zpx[x, y] = 255
    borde = zona.filter(ImageFilter.MaxFilter(5)).load()

    def fondo_caja(x, y):
        """Color de la caja alrededor de (x, y), promediando la zona rellenada."""
        sr = sg = sb = n = 0
        for yy in range(max(0, y - 12), min(alto, y + 13)):
            for xx in range(max(0, x - 12), min(ancho, x + 13)):
                if dentro[yy][xx]:
                    r, g, b = px[xx, yy]
                    sr += r; sg += g; sb += b; n += 1
        if not n:
            return None
        return sr / n, sg / n, sb / n

    salida = im.convert('RGBA')
    dp = salida.load()
    for y in range(alto):
        for x in range(ancho):
            if fuera[y][x] or dentro[y][x]:
                dp[x, y] = (0, 0, 0, 0)
                continue
            if borde[x, y] and min(px[x, y]) >= 110:
                viejo = fondo_caja(x, y)
                if viejo:
                    r, g, b = px[x, y]
                    # cuanto de la letra hay en este pixel, canal por canal
                    alfa = [min(1.0, max(0.0, (c - v) / (255.0 - v)))
                            for c, v in zip((r, g, b), viejo)]
                    a = sum(alfa) / 3.0
                    dp[x, y] = (int(255 * a + (1 - a) * AZUL[0]),
                                int(255 * a + (1 - a) * AZUL[1]),
                                int(255 * a + (1 - a) * AZUL[2]), 255)

    return salida.crop(salida.getchannel('A').getbbox() or (0, 0, ancho, alto))


def bloque_maestro(logo):
    """Arma el bloque con 'Tramites' arriba y el logo debajo."""
    alto_logo = int(logo.height * LOGO_ANCHO / logo.width)
    ancho = LOGO_ANCHO + MARGEN_X * 2

    objetivo = LOGO_ANCHO * FIT
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

    f2 = ImageFont.truetype(LETRA, max(10, int(tam * SALUDO_REL)))
    caja2 = f2.getbbox(SALUDO)
    alto_saludo = caja2[3] - caja2[1]

    alto_bloque = alto_saludo + GAP_LINEAS + alto_texto + GAP + alto_logo
    img = Image.new('RGBA', (ancho, alto_bloque), (0, 0, 0, 0))
    lapiz = ImageDraw.Draw(img)

    # Sin sombra: sobre azul plano el blanco ya resalta y la sombra difuminaba
    # los bordes de las letras, que es justo lo que hay que evitar.
    sx = (ancho - (caja2[2] - caja2[0])) // 2 - caja2[0]
    lapiz.text((sx, -caja2[1]), SALUDO, font=f2, fill=(255, 255, 255, 235))

    tx = (ancho - (caja[2] - caja[0])) // 2 - caja[0]
    ty = alto_saludo + GAP_LINEAS - caja[1]
    lapiz.text((tx, ty), TEXTO, font=f, fill=(255, 255, 255, 255))

    # El logo viene de una foto de 553 px: al agrandarlo se afina un poco para
    # que las letras SAIME no salgan borrosas.
    pieza = logo.resize((LOGO_ANCHO, alto_logo), Image.LANCZOS)
    pieza = pieza.filter(ImageFilter.UnsharpMask(radius=1.6, percent=85, threshold=2))
    img.alpha_composite(pieza, ((ancho - LOGO_ANCHO) // 2, alto_saludo + GAP_LINEAS + alto_texto + GAP))
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
    return lienzo.filter(ImageFilter.UnsharpMask(radius=1.2, percent=45, threshold=2))


def main():
    logo = logo_limpio()
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
