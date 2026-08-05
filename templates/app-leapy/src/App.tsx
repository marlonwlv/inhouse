export default function App() {
  return (
    <main className="pagina">
      <section className="cartao">
        <div className="logo" aria-hidden="true">
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
            <rect width="44" height="44" rx="12" fill="var(--verde)" />
            <path
              d="M14 30V14h4v12.5h8V30H14z"
              fill="#fff"
            />
            <circle cx="29" cy="16.5" r="3" fill="var(--ambar)" />
          </svg>
        </div>
        <h1>Seu app novo está no ar</h1>
        <p className="destaque">
          Descreva no chat o que ele deve fazer — a cada tarefa concluída, esta tela dá
          lugar ao seu app de verdade.
        </p>
        <ul className="dicas">
          <li>Peça uma tela, um formulário, um relatório…</li>
          <li>Você aprova o plano antes de qualquer mudança.</li>
          <li>Teste tudo aqui no preview antes de publicar.</li>
        </ul>
        <footer className="rodape">Feito com o Inhouse Builder</footer>
      </section>
    </main>
  );
}
