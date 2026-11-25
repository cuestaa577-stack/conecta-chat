#!/usr/bin/env python3
"""
Genera el icono pequeno (badge) de las notificaciones push.

Por que existe este script
--------------------------
Android no dibuja el badge a color: lo usa como plantilla. Toma SOLO el canal
alfa y pinta la figura de un color plano (blanco o el color del sistema). Si le
pasas un PNG opaco, el resultado es un cuadro blanco lleno: ese es el "icono en
blanco" que se veia en la notificacion.

Por eso el badge tiene que ser:
  - PNG con fondo TRANSPARENTE
  - una sola figura blanca (sin color)
  - con aire alrededor (zona segura), porque el sistema lo recorta

Se arma desde el mismo logo SAIME que usa el icono grande, en silueta blanca,
para que se vea igual pero legible a 24 px.

Uso:  python3 scripts/make-badge.py
Salida: public/badge-96.png, badge-72.png, badge-48.png
        y /tmp/badge_preview.png para revisar a ojo.
"""
import importlib.util
import os

from PIL import Image

AQUI = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(AQUI, '..', 'public')

SALIDAS = {'badge-96.png': 96, 'badge-72.png': 72, 'badge-48.png': 48}
OCUPACION = 0.80  # cuanto del cuadro ocupa la figura (deja zona segura)


def cargar_make_icon():
    """Reutiliza la limpieza del logo que ya hace make-icon.py."""
    ruta = os.path.join(AQUI, 'make-icon.py')
    spec = importlib.util.spec_from_file_location('make_icon', ruta)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def silueta_blanca(logo):
    """Deja la forma del logo (letras + cinta) en blanco puro, con su alfa."""
    sil = Image.new('RGBA', logo.size, (255, 255, 255, 0))
    sil.putalpha(logo.getchannel('A'))
    return sil


def badge(sil, size):
    """Centra la silueta en un cuadro transparente del tamano pedido.

    A 24-48 px los trazos de las letras se afinan hasta desaparecer, asi que en
    los tamanos chicos se engorda un poco la silueta antes de reducir. Es el
    mismo truco que usan los iconos de sistema: a menos pixeles, mas grosor.
    """
    lienzo = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    caja = size * OCUPACION
    k = min(caja / sil.width, caja / sil.height)
    w = max(1, int(sil.width * k))
    h = max(1, int(sil.height * k))

    pieza = sil
    if size <= 48:
        # engordar en el tamano grande, antes de reducir: el resultado queda
        # con el trazo parejo y no con puntas sueltas
        from PIL import ImageFilter
        alfa = sil.getchannel('A').filter(ImageFilter.MaxFilter(5))
        pieza = Image.new('RGBA', sil.size, (255, 255, 255, 0))
        pieza.putalpha(alfa)

    pieza = pieza.resize((w, h), Image.LANCZOS)
    lienzo.alpha_composite(pieza, ((size - w) // 2, (size - h) // 2))
    return lienzo


def preview(sil):
    """Hoja de contacto: el badge sobre fondo oscuro y claro, a 96/48/24 px."""
    tamanos = (96, 48, 24)
    piezas = [badge(sil, s) for s in tamanos]
    ancho = sum(p.width for p in piezas) + 20 * (len(piezas) + 1)
    alto = 96 + 40
    hoja = Image.new('RGB', (ancho, alto * 2), (32, 33, 36))
    for fila, fondo in enumerate(((32, 33, 36), (255, 255, 255))):
        base = Image.new('RGB', (ancho, alto), fondo)
        x = 20
        for p in piezas:
            base.paste(p, (x, (alto - p.height) // 2), p)
            x += p.width + 20
        hoja.paste(base, (0, fila * alto))
    hoja.save('/tmp/badge_preview.png')
    print('preview /tmp/badge_preview.png')


def main():
    make_icon = cargar_make_icon()
    logo = make_icon.logo_limpio()
    sil = silueta_blanca(logo)

    for nombre, size in SALIDAS.items():
        img = badge(sil, size)
        img.save(os.path.join(PUBLIC, nombre), optimize=True)
        alfa = img.getchannel('A')
        print('escrito %s (%dx%d) alfa %d..%d' % (
            nombre, img.width, img.height, alfa.getextrema()[0], alfa.getextrema()[1]))

    preview(sil)
    print('Listo. Sube la version de cache en sw.js, index.html y manifest.json.')


if __name__ == '__main__':
    main()
