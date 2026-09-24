const DOT = `<span style="font-family: 'Trebuchet MS', 'Lucida Grande', sans-serif; font-size: 1.10em">·</span>`;
const IMG = 'https://www.webassign.net/wastatic/wacache8e632469e60886dadce868f9b3eab2dd/watex/img';
const paren = (side: 'left' | 'right') =>
  `<span class="watexinlineblock watexmiddle"><table class="watexparen${side} watexparensmall"><tbody><tr><td class="watexparenimage"><img src="${IMG}/${side}angle0.gif" style="width: 0.3866em; height: 1.3918em"></td></tr></tbody></table></span>`;
const MINUS = `<span style="font: inherit 2.00em/2.00em Trebuchet MS, Lucida Grande, sans-serif; padding: 0px">−</span>`;
const it = (v: string) => `<span style="font-style: italic;"><span style="font-style: italic;">${v}</span></span>`;
const bold = (v: string) => `<span style="font-weight: bold;">${v}</span>`;
const vec = (...xs: string[]) => `${paren('left')}${xs.join(', ')}${paren('right')}`;
const line = (s: string) => `<span class="watexinlineblock"><span class="watex watexlineheightnormal"><div class="watexline">${s}</div></span></span>`;
const GAP = '<span style="white-space: nowrap">&nbsp;&nbsp;&nbsp;&nbsp;</span>';

const radios = (n: number, opts: string[]) => `<div class="multBox questionRadio">${opts.map((o, v) =>
  `<span class="ms"> <span class="wa-opt" data-box="${n}" data-value="${v}"></span><label class="wa-opt-label" data-box="${n}" data-value="${v}">${o}</label> </span>`).join('')}</div>`;

const sub = (label: string, body: string) =>
  `<div class="subblock"><div class="sublabel"><h4 class="aria-index">${label}</h4></div><div class="subpart">${body}</div></div>`;

const expr = (a: string) => `<div class="wa1par"> ${a} </div>`;

export const FIXTURE_HTML: Record<number, string> = {
  1: `<div class="studentQuestionBox studentQuestionContent">
    <div class="wa1par"> Which of the following expressions are meaningful? Which are meaningless? Explain. </div>
    ${sub('(a)', `${expr(`(<strong>a</strong> ${DOT} <strong>b</strong>) ${DOT} <strong>c</strong>`)}
      <div class="wa1ans fitb"> The expression (<strong>a</strong> ${DOT} <strong>b</strong>) ${DOT} <strong>c</strong> has <span class="wa-slot" data-box="1"></span> because it is the dot product of <span class="nobr"><span class="wa-slot" data-box="2"></span> .</span> </div>`)}
    ${sub('(b)', `${expr(`(<strong>a</strong> ${DOT} <strong>b</strong>)<strong>c</strong>`)}
      <div class="wa1ans fitb"> The expression (<strong>a</strong> ${DOT} <strong>b</strong>)<strong>c</strong> has <span class="wa-slot" data-box="3"></span> because it is a scalar multiple of <span class="nobr"><span class="wa-slot" data-box="4"></span> .</span> </div>`)}
  </div>`,
  2: `<div class="studentQuestionBox studentQuestionContent">
    <div class="wa1par"> Find <strong>a</strong> ${DOT} <strong>b</strong>. </div>
    <div class="wa1given"> ${line(`${bold('a')} =&nbsp;${vec(it('p'), `${MINUS}${it('p')}`, `<span style="color: black">5</span>${it('p')}`)},${GAP}${bold('b')} =&nbsp;${vec(`<span style="color: black">2</span>${it('q')}`, it('q'), `${MINUS}${it('q')}`)}`)} </div>
    <div class="wa1ans"> <span class="wa-slot" data-box="1"></span> </div>
  </div>`,
  4: `<div class="studentQuestionBox studentQuestionContent">
    <div class="wa1par"> If <strong>u</strong> is a unit vector, find <strong>u</strong> ${DOT} <strong>v</strong> and <strong>u</strong> ${DOT} <strong>w</strong>. (Assume <strong>v</strong> and <strong>w</strong> are also unit vectors.) </div>
    <div class="figure"> <img src="https://www.webassign.net/scalcet7/12-3-011.gif" alt=""> </div>
    <div class="wa1ans"> <span class="stackblock">
      <span class="stackline"> <span class="stackmath"> <strong>u</strong> ${DOT} <strong>v</strong> </span><span class="stackop">=</span><span class="stackans"> <span class="qTextField"> <span class="wa-slot" data-box="1"></span></span> </span></span>
      <span class="stackline"> <span class="stackmath"> <strong>u</strong> ${DOT} <strong>w</strong> </span><span class="stackop">=</span><span class="stackans"> <span class="qTextField"> <span class="wa-slot" data-box="2"></span></span> </span></span>
    </span> </div>
  </div>`,
  5: `<div class="studentQuestionBox studentQuestionContent">
    <div class="wa1par"> Determine whether the given vectors are orthogonal, parallel, or neither. </div>
    ${sub('(a)', `<div class="wa1par"> ${line(`${bold('u')} =&nbsp;${vec(`<span style="color: black">${MINUS}7</span>`, '4', `<span style="color: black">${MINUS}4</span>`)},${GAP}${bold('v')} =&nbsp;${vec('<span style="color: black">5</span>', '4', `${MINUS}1`)}`)} </div>
      <div class="wa1ans"> ${radios(1, ['orthogonal', 'parallel', 'neither'])} </div>`)}
    ${sub('(b)', `<div class="wa1par"> ${line(`${bold('u')} = <span style="color: black">15</span>${bold('i')} ${MINUS} <span style="color: black">12</span>${bold('j')} + <span style="color: black">9</span>${bold('k')},${GAP}${bold('v')} = <font color="black">${MINUS}10</font>${bold('i')} + <span style="color: black">8</span>${bold('j')} ${MINUS} <span style="color: black">6</span>${bold('k')}`)} </div>
      <div class="wa1ans"> ${radios(2, ['orthogonal', 'parallel', 'neither'])} </div>`)}
    ${sub('(c)', `<div class="wa1par"> ${line(`${bold('u')} =&nbsp;${vec(it('c'), it('c'), it('c'))},${GAP}${bold('v')} =&nbsp;${vec(it('c'), '0', `${MINUS}${it('c')}`)}`)} </div>
      <div class="wa1ans"> ${radios(3, ['orthogonal', 'parallel', 'neither'])} </div>`)}
  </div>`,
  6: `<div class="studentQuestionBox studentQuestionContent">
    <div class="wa1par"> Which figure shows <strong>u</strong>, <strong>v</strong> and <strong>w</strong> as unit vectors? <i>(synthetic image-choice test)</i> </div>
    <div class="wa1ans"> ${radios(1, [0, 1, 2].map((i) => `<img src="https://www.webassign.net/scalcet7/12-3-011.gif" alt="figure ${i + 1}" style="height: 110px">`))} </div>
  </div>`,
};

export const FIXTURE_CSS = `
.qhtml .figure { margin-bottom: 1em; margin-left: 10em; margin-top: 1em }
.qhtml .qContent .multBox { margin: 0 0 0 1.5em }
.qhtml .qContent .questionRadio { text-indent: -1.5em }
.qhtml .qContent .questionRadio span.ms { display: block; margin: 0 0 0.6em 1.8em; clear: both }
.qhtml .qContent .figure { margin: 1em 0 0 8em }
.qhtml .qContent .nobr { white-space: nowrap }
.qhtml .watexinlineblock { position: relative; display: inline-block }
.qhtml span.watex { display: block; margin: 0 }
.qhtml .watexlineheightnormal { line-height: normal }
.qhtml .watexparenleft, .qhtml .watexparenright { border-collapse: collapse; margin-top: 0.147059em; margin-bottom: 0.147059em }
.qhtml .watexparenimage { vertical-align: middle; padding: 0 }
.qhtml .watexparenimage img { display: block }
.qhtml .watexparenright .watexparenimage { padding-right: 0.0735294em }
.qhtml .watexmiddle { vertical-align: middle }
.qhtml .qContent .wa1par { font-family: verdana, geneva, sans-serif; font-size: 13px; color: inherit; margin: 0 0 1em 0; line-height: 1.4em }
.qhtml .qContent .wa1given { margin: 0 0 1em 6em; font-family: verdana, geneva, sans-serif; color: inherit }
.qhtml .qContent .wa1ans { margin: -0.5em 0 1em 0; font-family: verdana, geneva, sans-serif; color: inherit }
.qhtml .qContent .fitb { margin: 0 0 1em 0 }
.qhtml .qContent .subblock { margin: 0 0 1em 0; font-size: 13px; font-family: verdana, geneva, sans-serif; color: inherit; display: flex; flex-flow: row nowrap; justify-content: flex-start; align-items: baseline }
.qhtml .qContent .sublabel { margin-left: 0.5em; width: 2em; flex: 0 0 auto; font-size: 13px; font-family: verdana, geneva, sans-serif; color: inherit }
.qhtml .qContent .subpart { margin-left: 0.5em; font-size: 13px; font-family: verdana, geneva, sans-serif; color: inherit; line-height: 1.4em }
.qhtml .qContent .stackblock { display: table }
.qhtml .qContent .stackline { display: table-row }
.qhtml .qContent .stacktext { margin: 0 0 0.3em 0; padding-right: 2em; padding-bottom: 0.3em; display: table-cell; text-align: left }
.qhtml .qContent .stackmath { margin: 0 0 0.3em 0; display: table-cell; padding-right: 0.4em; padding-bottom: 0.3em; text-align: right }
.qhtml .qContent .stackans { margin: 0 0 0.3em 0; padding-bottom: 0.3em; display: table-cell; text-align: left }
.qhtml .qContent .stackop { padding: 0 0.6em 0.3em 0.2em; display: table-cell; text-align: left }
`;
