const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // <-- Aggiungiamo questa

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Costringiamo il server a puntare esattamente alla cartella "public"
app.use(express.static(path.join(__dirname, 'public')));

const stanze = {};
const risposteCasuali = ["Giallo", "12", "Ogni tanto", "Solo la domenica", "Mio cugino", "Un pinguino", "Assolutamente no", "3,14", "La pizza all'ananas", "Il 1998"];

function generaCodice() {
    const caratteri = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let codice = '';
    for (let i = 0; i < 4; i++) codice += caratteri.charAt(Math.floor(Math.random() * caratteri.length));
    return codice;
}

function calcolaPunteggiEFineRound(codiceStanza) {
    const stanza = stanze[codiceStanza];
    
    stanza.domandeRicevute.forEach(domanda => {
        if (stanza.punteggi[domanda.giocatore] !== undefined) {
            stanza.punteggi[domanda.giocatore] += domanda.totaleVoti;
        }
    });

    const classifica = stanza.giocatori.map(id => {
        return { nome: stanza.nomi[id], punti: stanza.punteggi[id] };
    }).sort((a, b) => b.punti - a.punti);

    const eUltimoRound = stanza.roundCorrente >= stanza.impostazioni.round;

    io.to(codiceStanza).emit('fineRound', { classifica: classifica, finePartita: eUltimoRound });

    setTimeout(() => {
        if (!eUltimoRound) iniziaRound(codiceStanza);
        else io.to(codiceStanza).emit('vincitoreFinale', classifica[0]);
    }, 8000);
}

function mostraDomandaDaVotare(codiceStanza) {
    const stanza = stanze[codiceStanza];
    if (stanza.indiceDomandaAttuale < stanza.domandeRicevute.length) {
        const domanda = stanza.domandeRicevute[stanza.indiceDomandaAttuale];
        stanza.votiCorrenti = 0; 
        
        // Calcoliamo i voti necessari (Tutti i giocatori tranne l'autore)
        const votiRichiesti = stanza.giocatori.length - 1;

        // Se state testando il gioco da soli (1 sola scheda aperta), salta la votazione per non bloccarsi
        if (votiRichiesti <= 0) {
            stanza.indiceDomandaAttuale++;
            setTimeout(() => { mostraDomandaDaVotare(codiceStanza); }, 500);
            return;
        }
        
        io.to(codiceStanza).emit('mostraDomandaVotazione', {
            testoDomanda: domanda.testo,
            indice: stanza.indiceDomandaAttuale + 1,
            totaleDomande: stanza.domandeRicevute.length,
            rispostaOriginale: stanza.rispostaAttuale,
            autore: domanda.giocatore // Inviamo l'ID dell'autore al client
        });
    } else {
        calcolaPunteggiEFineRound(codiceStanza);
    }
}

function terminaFaseScrittura(codiceStanza) {
    const stanza = stanze[codiceStanza];
    if (!stanza) return;

    io.to(codiceStanza).emit('fineTempoScrittura');
    stanza.indiceDomandaAttuale = 0; 
    setTimeout(() => { mostraDomandaDaVotare(codiceStanza); }, 1500);
}

function iniziaRound(codiceStanza) {
    const stanza = stanze[codiceStanza];
    stanza.roundCorrente++;
    stanza.domandeRicevute = [];
    
    const rispostaScelta = risposteCasuali[Math.floor(Math.random() * risposteCasuali.length)];
    stanza.rispostaAttuale = rispostaScelta;

    io.to(codiceStanza).emit('nuovoRound', {
        round: stanza.roundCorrente, totaleRound: stanza.impostazioni.round,
        risposta: rispostaScelta, tempo: stanza.impostazioni.tempo
    });

    stanza.timerId = setTimeout(() => { terminaFaseScrittura(codiceStanza); }, stanza.impostazioni.tempo * 1000);
}

io.on('connection', (socket) => {
    socket.on('creaPartita', (dati) => {
        const codice = generaCodice();
        stanze[codice] = {
            host: socket.id, giocatori: [socket.id],
            nomi: { [socket.id]: dati.nome || "Host" },
            impostazioni: dati.impostazioni, stato: 'attesa',
            roundCorrente: 0, domandeRicevute: [], punteggi: {}
        };
        stanze[codice].punteggi[socket.id] = 0;
        socket.join(codice);
        socket.emit('partitaCreata', codice);
    });

    socket.on('entraPartita', (dati) => {
        const codice = dati.codice.toUpperCase();
        if (stanze[codice]) {
            stanze[codice].giocatori.push(socket.id);
            stanze[codice].nomi[socket.id] = dati.nome || "Giocatore";
            stanze[codice].punteggi[socket.id] = 0; 
            socket.join(codice);
            socket.emit('ingressoConfermato', codice);
            io.to(codice).emit('aggiornamentoGiocatori', stanze[codice].giocatori.length);
        }
    });

    socket.on('richiestaInizioGioco', (codice) => {
        if (stanze[codice] && stanze[codice].host === socket.id) iniziaRound(codice);
    });

    socket.on('inviaDomanda', (dati) => {
        const stanza = stanze[dati.codice];
        if (stanza) {
            stanza.domandeRicevute.push({ giocatore: socket.id, testo: dati.domanda, totaleVoti: 0 });
            if (stanza.domandeRicevute.length === stanza.giocatori.length) {
                clearTimeout(stanza.timerId); 
                terminaFaseScrittura(dati.codice); 
            }
        }
    });

    socket.on('inviaVoto', (dati) => {
        const stanza = stanze[dati.codice];
        if (stanza) {
            stanza.votiCorrenti++;
            stanza.domandeRicevute[stanza.indiceDomandaAttuale].totaleVoti += parseInt(dati.voto);
            
            const votiRichiesti = stanza.giocatori.length - 1; // Controlliamo quanti voti servono

            if (stanza.votiCorrenti >= votiRichiesti) {
                stanza.indiceDomandaAttuale++;
                setTimeout(() => { mostraDomandaDaVotare(dati.codice); }, 1000);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Noitseuq avviato sulla porta ${PORT}`));