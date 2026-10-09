import{t as e}from"./download-b5K-kF2o.js";async function t(t,n,r){let i=r.map(e=>e.label).join(`,`),a=n.map(e=>r.map(t=>{let n=e[t.key]??``;return typeof n==`string`&&(n.includes(`,`)||n.includes(`"`))&&(n=`"`+n.replace(/"/g,`""`)+`"`),n}).join(`,`));return(await e(new Blob([`﻿`+i+`
`+a.join(`
`)],{type:`text/csv;charset=utf-8`}),t,{preferShare:!0,title:t})).ok}export{t};