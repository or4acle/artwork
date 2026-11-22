# Galeria simples

Uma galeria estática, sem framework e sem dependências. Funciona no GitHub Pages.

## Como adicionar mídias

1. Coloque imagens, vídeos e áudios dentro da pasta `media/`. Pode criar subpastas.
2. Rode `python generate_manifest.py`.
3. Envie `media/`, `media.json`, `index.html`, `style.css` e `gallery.js` para o GitHub.

O script cria a lista de arquivos porque o GitHub Pages não permite que o JavaScript descubra sozinho todos os arquivos de uma pasta publicada.

## Publicar no GitHub Pages

No repositório, abra **Settings → Pages**. Em **Build and deployment**, escolha **Deploy from a branch**, selecione `main` e `/ (root)`, e salve.

Depois que o Pages terminar a publicação, o site estará disponível no endereço mostrado nessa mesma página.

## O que tem

- Grade responsiva de imagens, vídeos e áudios.
- Clique para abrir em tamanho maior.
- Navegação com as setas do teclado.
- Busca pelo nome do arquivo.
- Sem bibliotecas, frameworks, banco de dados ou servidor.
