/* Last Card rules engine. Shared by the server (authoritative) and the browser (highlighting playable cards). */
const COLORS={r:'Red',y:'Yellow',g:'Green',b:'Blue'};
const CVAR={r:'var(--red)',y:'var(--yellow)',g:'var(--green)',b:'var(--blue)',w:'var(--wild)'};
const VORD='0123456789SRDWF', CORD='rygbw';
const cc=c=>c[0], cv=c=>c[1];
const mod=(a,n)=>((a%n)+n)%n;
const T=u=>'{{'+u+'}}';

function buildDeck(){
  const d=[];
  for(const c of 'rygb'){
    d.push(c+'0');
    for(let i=1;i<=9;i++) d.push(c+i,c+i);
    for(const v of 'SRD') d.push(c+v,c+v);
  }
  for(let i=0;i<4;i++) d.push('wW','wF');
  return d;
}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function label(c){const v=cv(c);return v==='S'?'⊘':v==='R'?'⇄':v==='D'?'+2':v==='F'?'+4':v==='W'?'W':v;}
function cardName(c){const v=cv(c);const n=v==='S'?'Skip':v==='R'?'Reverse':v==='D'?'+2':v==='W'?'Wild':v==='F'?'Wild +4':v;return cc(c)==='w'?n:COLORS[cc(c)]+' '+n;}
function topOf(s){return s.discard[s.discard.length-1];}
function canPlay(c,s){
  const top=topOf(s);
  if(s.pending>0){
    if(cv(c)==='F') return true;
    return cv(c)==='D' && cv(top)==='D';
  }
  if(cc(c)==='w') return true;
  return cc(c)===s.color || cv(c)===cv(top);
}
function refill(s){
  if(s.discard.length<2) return;
  const top=s.discard.pop();
  s.deck=shuffle(s.discard.slice());
  s.discard=[top];
}
function drawCards(s,uid,k){
  const h=s.hands[uid];let got=0;
  for(let i=0;i<k;i++){
    if(!s.deck.length) refill(s);
    if(!s.deck.length) break;
    h.push(s.deck.pop());got++;
  }
  return got;
}
function advance(s,k){s.turn=mod(s.turn+s.dir*k,s.order.length);s.turnAt=Date.now();s.drew=false;}
function pushLog(s,msg,kind){s.log=(s.log||[]).concat({v:s.v,msg,kind:kind||''}).slice(-14);}
function nextUid(s,k){return s.order[mod(s.turn+s.dir*(k||1),s.order.length)];}

function dealRound(s,seated){
  const deck=shuffle(buildDeck());const hands={};
  seated.forEach(u=>hands[u]=[]);
  for(let r=0;r<7;r++) seated.forEach(u=>hands[u].push(deck.pop()));
  let top=deck.pop();
  while(!/[0-9]/.test(cv(top))){deck.unshift(top);top=deck.pop();}
  Object.assign(s,{status:'playing',order:seated.slice(),hands,deck,discard:[top],color:cc(top),
    turn:Math.floor(Math.random()*seated.length),dir:1,pending:0,drew:false,unsafe:null,unsafeV:0,
    winner:null,turnAt:Date.now(),round:(s.round||0)+1,last:null});
  s.wins=Object.assign({},s.wins||{});
  s.log=[];
  pushLog(s,'Round '+s.round+': '+T(s.order[s.turn])+' goes first');
}

/* returns false when the move is not allowed */
function applyPlay(s,me,idx,chosen,called){
  if(s.status!=='playing'||s.order[s.turn]!==me) return false;
  const h=s.hands[me];const c=h[idx];
  if(!c) return false;
  if(s.drew && idx!==h.length-1) return false;
  if(!canPlay(c,s)) return false;
  const wild=cc(c)==='w';
  if(wild && !COLORS[chosen]) return false;
  s.unsafe=null;
  h.splice(idx,1);s.discard.push(c);
  s.color=wild?chosen:cc(c);
  s.last={by:me,card:c,v:s.v};
  const n=s.order.length,v=cv(c);
  let msg=T(me)+' played '+cardName(c)+(wild?' → '+COLORS[s.color]:'');
  if(h.length===0){
    s.status='over';s.winner=me;s.pending=0;s.wins[me]=(s.wins[me]||0)+1;
    pushLog(s,T(me)+' played their last card and wins the round!','win');
    return true;
  }
  let kind='';
  if(h.length===1){
    if(called){msg+=' · Last card!';kind='call';}
    else{s.unsafe=me;s.unsafeV=s.v;}
  }
  if(v==='S'){msg+=' · '+T(nextUid(s))+' is skipped';advance(s,2);}
  else if(v==='R'){
    if(n===2){msg+=' · goes again';advance(s,2);}
    else{s.dir*=-1;msg+=' · play now goes '+(s.dir===1?'clockwise':'anticlockwise');advance(s,1);}
  }
  else if(v==='D'||v==='F'){
    const k=v==='D'?2:4;
    if(s.settings&&s.settings.stack){
      s.pending=(s.pending||0)+k;advance(s,1);
      msg+=' · '+T(s.order[s.turn])+' must stack or draw '+s.pending;
    }else{
      const t=nextUid(s);drawCards(s,t,k);
      msg+=' · '+T(t)+' draws '+k+' and is skipped';advance(s,2);
    }
  }
  else advance(s,1);
  pushLog(s,msg,kind);
  return true;
}
function applyDraw(s,me){
  if(s.status!=='playing'||s.order[s.turn]!==me) return false;
  if(s.drew&&!(s.pending>0)) return false;
  s.unsafe=null;
  if(s.pending>0){
    const k=s.pending;const got=drawCards(s,me,k);s.pending=0;
    pushLog(s,T(me)+' draws '+got);advance(s,1);return true;
  }
  if(s.drew) return false;
  const h=s.hands[me];let k=0;
  if(s.settings&&s.settings.drawUntil){
    while(k<60){if(!drawCards(s,me,1)) break;k++;if(canPlay(h[h.length-1],s)) break;}
  }else k=drawCards(s,me,1);
  const what=k===0?'could not draw (deck empty)':k===1?'drew a card':'drew '+k+' cards';
  if(k&&canPlay(h[h.length-1],s)){s.drew=true;pushLog(s,T(me)+' '+what);}
  else{pushLog(s,T(me)+' '+what+' and passed');advance(s,1);}
  return true;
}
function applyPass(s,me){
  if(s.status!=='playing'||s.order[s.turn]!==me||!s.drew) return false;
  pushLog(s,T(me)+' kept the card and passed');advance(s,1);return true;
}
function applyCatch(s,catcher,target,v){
  if(s.status!=='playing'||s.unsafe!==target||s.unsafeV!==v) return false;
  drawCards(s,target,2);s.unsafe=null;
  pushLog(s,T(catcher)+' caught '+T(target)+' without a Last card call · +2 cards','catch');
  return true;
}
function applyLateCall(s,uid,v){
  if(s.status!=='playing'||s.unsafe!==uid||s.unsafeV!==v) return false;
  s.unsafe=null;pushLog(s,T(uid)+' called Last card! just in time','call');return true;
}
function applySkipIdle(s,uid){
  if(s.status!=='playing'||s.order[s.turn]!==uid) return false;
  if(s.pending>0){drawCards(s,uid,s.pending);s.pending=0;}
  s.unsafe=null;
  pushLog(s,T(uid)+' took too long and was skipped');advance(s,1);return true;
}
function applyRemove(s,uid){
  const i=s.order.indexOf(uid);if(i<0) return false;
  const h=s.hands[uid]||[];s.deck=h.concat(s.deck);delete s.hands[uid];
  const wasTurn=i===s.turn;
  s.order.splice(i,1);
  const n=s.order.length;
  if(s.unsafe===uid) s.unsafe=null;
  if(n===0){s.status='lobby';return true;}
  if(wasTurn){s.turn=s.dir===1?mod(i,n):mod(i-1,n);s.drew=false;s.turnAt=Date.now();}
  else if(i<s.turn) s.turn--;
  pushLog(s,T(uid)+' left the round');
  if(n===1&&s.status==='playing'){
    s.status='over';s.winner=s.order[0];s.pending=0;s.wins[s.winner]=(s.wins[s.winner]||0)+1;
    pushLog(s,T(s.winner)+' is the last one standing and wins!','win');
  }
  return true;
}

if(typeof module!=='undefined'){
  module.exports={COLORS,CVAR,VORD,CORD,cc,cv,mod,T,buildDeck,shuffle,label,cardName,topOf,canPlay,refill,drawCards,advance,pushLog,nextUid,
    dealRound,applyPlay,applyDraw,applyPass,applyCatch,applyLateCall,applySkipIdle,applyRemove};
}
