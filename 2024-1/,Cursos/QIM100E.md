---
créditos: 10
nombre: Química para Ingeniería
semestre: 1
aprobado: true
notaObtenida: 5.9
sección: 3
año: 2024
dg-publish: true
prerrequisitos:
  - nt
semestreOfrecido:
  - P
  - I
concentracion: MScB
---
```dataviewjs
let notas = dv.pages().where(b=>b.file.frontmatter.Curso === dv.current().file.name).file.frontmatter.notaObtenida
let pond = dv.pages().where(b=>b.file.frontmatter.Curso === dv.current().file.name).file.frontmatter.Ponderación
let sigla = dv.pages().where(b=>b.file.frontmatter.Curso === dv.current().file.name).file.link
let arr = []
let nf = 0
for(i=0;i<=notas.length-1;i++){
    arr.push([sigla[i],notas[i],pond[i]])
    nf = nf + notas[i]*pond[i]
}
nf = Math.round(nf*10)/10
dv.table(["Evaluación","Nota","Ponderación"],arr)
dv.paragraph("$$\\Huge{\\text{NFC}="+nf+"}$$")
```