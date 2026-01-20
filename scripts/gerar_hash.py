#!/usr/bin/env python3
"""
Script para gerar hashes de senha para o CRM Varizemed (Fase 1)

Uso:
    python gerar_hash.py senha123

Ou para modo interativo:
    python gerar_hash.py
"""

import sys
from werkzeug.security import generate_password_hash

def main():
    if len(sys.argv) > 1:
        # Modo com argumento
        senha = sys.argv[1]
    else:
        # Modo interativo
        print("=== Gerador de Hash de Senha - CRM Varizemed ===")
        print()
        senha = input("Digite a senha: ")
        if not senha:
            print("❌ Senha não pode estar vazia!")
            sys.exit(1)
    
    # Gera o hash
    hash_senha = generate_password_hash(senha, method='scrypt')
    
    print()
    print("✅ Hash gerado com sucesso!")
    print()
    print("=" * 70)
    print(hash_senha)
    print("=" * 70)
    print()
    print("Use este hash no arquivo .env:")
    print(f"USER_NOMEDOUSUARIO_PASSWORD_HASH={hash_senha}")
    print()

if __name__ == "__main__":
    main()
