// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseMyInvestorHtml } from "./parseFiles";

const FONDOS_HTML = `
<html>
<body>
    <table border="1">
      <TR>
        <th colspan="2">Fechas</th>
        <th rowspan="2">Operación</th>
        <th rowspan="2">Mercado</th>
        <th rowspan="2">Operación</th>
        <th rowspan="2">ISIN</th>
        <th rowspan="2">Valor</th>
        <th rowspan="2">Títulos/NOMINAL</th>
        <th rowspan="2">Divisa</th>
        <th rowspan="2">Precio Neto</th>
        <th rowspan="2">Importe neto</th>
      </TR>
      <tr>
        <th>Operación</th>
        <th>Liquidación</th>
      </tr>
      <tr>
        <td align="center">2025-10-14&nbsp;</td>
        <td align="center">2025-10-16&nbsp;</td>
        <td> 231531632</td>
        <td>FONDOS EXTRANJEROS</td>
        <td>SUSCR.POR TRASPASO I</td>
        <td>IE000N51F726</td>
        <td>ISHARES DEVELOPED WORLD D EUR</td>
        <td x:num="4.55000000">4.55000000</td>
        <td>EUR</td>
        <td x:num="10.4800000">10.4800000</td>
        <td x:num="47.72">47.72</td>
      </tr>
      <tr>
        <td align="center">2026-01-06&nbsp;</td>
        <td align="center">2026-01-09&nbsp;</td>
        <td> 247469778</td>
        <td>FONDOS EXTRANJEROS</td>
        <td>SUSCRIPCION</td>
        <td>IE000QAZP7L2</td>
        <td>ISHARES EMERGING MRK IND S EUR</td>
        <td x:num="4.61000000">4.61000000</td>
        <td>EUR</td>
        <td x:num="11.6260000">11.6260000</td>
        <td x:num="53.71">53.71</td>
      </tr>
    </table>
</body>
</html>`;

const MOVIMIENTOS_HTML = `
<html>
 <body>
   <table border="1">
    <tr>
     <th>Fecha operación</th>
     <th>Fecha valor</th>
     <th>Tipo de operación</th>
     <th>Concepto</th>
     <th>Divisa</th>
     <th>Importe</th>
    </tr>
    <tr>
     <td align="center">06/01/2026&nbsp;</td>
     <td align="center">09/01/2026&nbsp;</td>
     <td>SUSCRIPCION IIC</td>
     <td>ISHARES EMERGING MRK IND S EUR @ 4.61</td>
     <td>EUR</td>
     <td>-53,71</td>
    </tr>
    <tr>
     <td align="center">06/07/2026&nbsp;</td>
     <td align="center">03/07/2026&nbsp;</td>
     <td>COMISION CUSTODIA MYINVESTOR</td>
     <td>EFECTIVO-EUR @ 0</td>
     <td>EUR</td>
     <td>-2,48</td>
    </tr>
   </table>
 </body>
</html>`;

const MOVIMIENTOS_HTML_MOJIBAKE = `
<html>
 <body>
   <table border="1">
    <tr>
     <th>Fecha operaci�n</th>
     <th>Fecha valor</th>
     <th>Tipo de operaci�n</th>
     <th>Concepto</th>
     <th>Divisa</th>
     <th>Importe</th>
    </tr>
    <tr>
     <td align="center">23/07/2026&nbsp;</td>
     <td align="center">27/07/2026&nbsp;</td>
     <td>COMPRA RV CONTADO SF</td>
     <td>SAP AG @ 20</td>
     <td>EUR</td>
     <td>-2.642,00</td>
    </tr>
   </table>
 </body>
</html>`;

describe("parseMyInvestorHtml", () => {
  it("parses the fondos (consulta de operaciones) table", () => {
    const result = parseMyInvestorHtml(FONDOS_HTML);
    expect(result.kind).toBe("fondos");
    if (result.kind !== "fondos") throw new Error("expected fondos");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      fechaOperacion: "2025-10-14",
      fechaLiquidacion: "2025-10-16",
      numOperacion: "231531632",
      operacion: "SUSCR.POR TRASPASO I",
      isin: "IE000N51F726",
      titulos: "4.55000000",
      divisa: "EUR",
    });
  });

  it("parses the movimientos (cuenta corriente) table and normalises dates", () => {
    const result = parseMyInvestorHtml(MOVIMIENTOS_HTML);
    expect(result.kind).toBe("movimientos");
    if (result.kind !== "movimientos") throw new Error("expected movimientos");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      fechaOperacion: "2026-01-06",
      fechaValor: "2026-01-09",
      tipo: "SUSCRIPCION IIC",
      importe: "-53,71",
    });
  });

  it("returns unknown for unrelated HTML", () => {
    const result = parseMyInvestorHtml("<html><body><table><tr><td>x</td></tr></table></body></html>");
    expect(result.kind).toBe("unknown");
  });

  it("detects movimientos tables when headers contain mojibake accents (operaci�n)", () => {
    const result = parseMyInvestorHtml(MOVIMIENTOS_HTML_MOJIBAKE);
    expect(result.kind).toBe("movimientos");
    if (result.kind !== "movimientos") throw new Error("expected movimientos");
    expect(result.rows[0].tipo).toBe("COMPRA RV CONTADO SF");
  });
});
