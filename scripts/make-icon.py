#!/usr/bin/env python3
"""
Genera el icono de la app como VECTOR y lo rasteriza a PNG.

Por que existe este script
--------------------------
El icono original era un PNG de 192 px que se habia ampliado a 512 px. Al
ampliar una imagen pequena los bordes se suavizan y en la pantalla de inicio
del telefono el icono se veia borroso. Aqui el icono se dibuja con formas y
texto reales (SVG) y se rasteriza a 1024 px; de ahi se reducen los demas
tamanos. Al reducir desde 1024 los bordes quedan nitidos en todos los tamanos.

El tamano de la letra del anillo NO esta escrito a mano: se mide el texto con
la fuente real y se calcula el tamano que cabe justo en el arco. Asi el texto
nunca se sale ni se corta, aunque cambie la frase.

Uso:  python3 scripts/make-icon.py
Salida: public/icon-1024.png, icon-512.png, icon-192.png,
        icon-maskable-512.png, icon-maskable-192.png,
        apple-touch-icon.png, favicon-32.png
"""
import math
import os

import cairosvg
from PIL import Image, ImageFont

AQUI = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(AQUI, '..', 'public')

NAVY = '#1d5d9c'
AMARILLO = '#f7d117'
AZUL = '#0033a0'
ROJO = '#cf142b'
ORO = '#c9a227'

TEXTO = 'MINISTERIO DEL PODER POPULAR PARA RELACIONES INTERIORES, JUSTICIA Y PAZ'

# Fuente real que usa cairosvg para medir y para dibujar. Si no esta, se cae a
# la sans-serif del sistema; el calculo del tamano se hace igual con la que
# exista, asi que el texto sigue cabiendo.
FUENTES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
]


def fuente_medida(tam):
    for ruta in FUENTES:
        if os.path.exists(ruta):
            return ImageFont.truetype(ruta, tam)
    return ImageFont.load_default()


def ancho_texto(texto, tam):
    f = fuente_medida(tam)
    try:
        return f.getlength(texto)
    except AttributeError:  # Pillow viejo
        return f.getsize(texto)[0]


def tamano_que_cabe(texto, arco_util, referencia=100):
    """Tamano de letra (en px del SVG) para que el texto quepa en el arco."""
    ancho_ref = ancho_texto(texto, referencia)
    if ancho_ref <= 0:
        return 20
    return max(8, int(referencia * arco_util / ancho_ref))


def estrella(cx, cy, r, relleno='#ffffff'):
    """Estrella de 5 puntas."""
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        rad = r if i % 2 == 0 else r * 0.42
        pts.append('{:.2f},{:.2f}'.format(cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return '<polygon points="{}" fill="{}"/>'.format(' '.join(pts), relleno)


def escudo(cx, cy, w, h):
    """Escudo pequeno y limpio: campo tricolor, borde dorado y estrella blanca.

    A 192 px el escudo real (caballo, trigo, armas) no se distingue: se veia
    como una mancha. Esta version simplificada se lee como emblema oficial a
    cualquier tamano y no inventa detalle que no se puede ver.
    """
    x0 = cx - w / 2
    y0 = cy - h / 2
    x1 = x0 + w
    y1 = y0 + h
    ym = y0 + h * 0.62
    d = (
        'M {x0:.2f} {y0:.2f} L {x1:.2f} {y0:.2f} L {x1:.2f} {ym:.2f} '
        'Q {x1:.2f} {y1:.2f} {cx:.2f} {y1:.2f} '
        'Q {x0:.2f} {y1:.2f} {x0:.2f} {ym:.2f} Z'
    ).format(x0=x0, x1=x1, y0=y0, y1=y1, ym=ym, cx=cx)

    franjas = []
    alto = h / 3.0
    for i, color in enumerate((AMARILLO, AZUL, ROJO)):
        franjas.append(
            '<rect x="{:.2f}" y="{:.2f}" width="{:.2f}" height="{:.2f}" fill="{}"/>'.format(
                x0, y0 + i * alto, w, alto + 0.5, color
            )
        )

    return (
        '<g>'
        '<clipPath id="clipEscudo"><path d="{}"/></clipPath>'
        '<g clip-path="url(#clipEscudo)">{}</g>'
        '<path d="{}" fill="none" stroke="{}" stroke-width="{:.2f}"/>'
        '{}'
        '</g>'
    ).format(
        d,
        ''.join(franjas),
        d,
        ORO,
        max(2.0, w * 0.06),
        estrella(cx, y0 + h * 0.50, w * 0.19),
    )


def svg(contenido_escala=1.0):
    """Icono completo. contenido_escala < 1 deja margen (icono maskable)."""
    S = 1024
    c = S / 2.0

    r_exterior = 430 * contenido_escala   # borde blanco del sello
    r_anillo = 300 * contenido_escala     # circulo tricolor
    r_texto = 366 * contenido_escala      # linea base del texto (en el blanco)

    # Arco superior para el texto: media vuelta, de izquierda a derecha.
    arco = 'M {:.2f} {:.2f} A {:.2f} {:.2f} 0 0 1 {:.2f} {:.2f}'.format(
        c - r_texto, c, r_texto, r_texto, c + r_texto, c
    )

    # El texto ocupa como mucho el 86 % del arco: deja aire en los extremos.
    arco_total = math.pi * r_texto
    fuente = tamano_que_cabe(TEXTO, arco_total * 0.86)

    # Ocho estrellas en arco sobre el escudo, como en la bandera.
    estrellas = []
    r_estrellas = r_anillo * 0.46
    cy_estrellas = c + r_anillo * 0.06
    for i in range(8):
        ang = math.radians(198 + i * (144 / 7))
        estrellas.append(
            estrella(
                c + r_estrellas * math.cos(ang),
                cy_estrellas + r_estrellas * math.sin(ang),
                r_anillo * 0.072,
            )
        )

    return """<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">
  <defs>
    <clipPath id="clipCirculo"><circle cx="{c}" cy="{c}" r="{r_anillo}"/></clipPath>
    <path id="arcoTexto" d="{arco}"/>
  </defs>

  <rect width="{S}" height="{S}" rx="{radio}" fill="{NAVY}"/>
  <circle cx="{c}" cy="{c}" r="{r_exterior}" fill="#ffffff"/>

  <g clip-path="url(#clipCirculo)">
    <rect x="{c0}" y="{c0}" width="{lado}" height="{lado}" fill="{AMARILLO}"/>
    <rect x="{c0}" y="{y2}" width="{lado}" height="{alto}" fill="{AZUL}"/>
    <rect x="{c0}" y="{y3}" width="{lado}" height="{alto}" fill="{ROJO}"/>
  </g>

  {estrellas}

  {escudo}

  <text font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="{fuente}"
        font-weight="700" fill="#111111">
    <textPath href="#arcoTexto" startOffset="50%" text-anchor="middle">{TEXTO}</textPath>
  </text>
</svg>""".format(
        S=S,
        c=c,
        radio=int(S * 0.175),
        NAVY=NAVY,
        r_exterior=r_exterior,
        r_anillo=r_anillo,
        arco=arco,
        c0=c - r_anillo,
        lado=r_anillo * 2,
        alto=r_anillo * 2 / 3.0,
        y2=c - r_anillo + r_anillo * 2 / 3.0,
        y3=c - r_anillo + r_anillo * 4 / 3.0,
        AMARILLO=AMARILLO,
        AZUL=AZUL,
        ROJO=ROJO,
        estrellas=''.join(estrellas),
        escudo=escudo(c, c + r_anillo * 0.44, r_anillo * 0.30, r_anillo * 0.40),
        fuente=fuente,
        TEXTO=TEXTO,
    )


def render(svg_texto, destino, tamano):
    cairosvg.svg2png(
        bytestring=svg_texto.encode('utf-8'),
        write_to=destino,
        output_width=tamano,
        output_height=tamano,
    )


def main():
    # Icono normal: el sello ocupa casi todo el cuadro.
    normal = svg(1.0)
    # Icono maskable: el sello se encoge para que ningun recorte del sistema
    # (circulo, squircle, esquinas) le corte el borde.
    maskable = svg(0.78)

    maestro = os.path.join(PUBLIC, 'icon-1024.png')
    render(normal, maestro, 1024)

    base = Image.open(maestro).convert('RGB')
    salidas = {
        'icon-512.png': 512,
        'icon-192.png': 192,
        'apple-touch-icon.png': 180,
        'favicon-32.png': 32,
    }
    for nombre, tam in salidas.items():
        base.resize((tam, tam), Image.LANCZOS).save(os.path.join(PUBLIC, nombre), optimize=True)

    tmp = os.path.join(PUBLIC, '_maskable_tmp.png')
    render(maskable, tmp, 1024)
    grande = Image.open(tmp).convert('RGB')
    for nombre, tam in (('icon-maskable-512.png', 512), ('icon-maskable-192.png', 192)):
        grande.resize((tam, tam), Image.LANCZOS).save(os.path.join(PUBLIC, nombre), optimize=True)
    os.remove(tmp)

    print('Iconos generados en', PUBLIC, '| letra del anillo:', tamano_que_cabe(TEXTO, math.pi * 366 * 0.86), 'px')


if __name__ == '__main__':
    main()
