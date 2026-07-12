import { parseBook } from './src/parser/index.js';
import path from 'path';

const booksDir = '/home/ubuntu/.ireader/data/books';
const bookId = '9d159acc-9074-496d-b881-34c6f94104ed';
const bookDir = path.join(booksDir, bookId);
const sourceFile = path.join(bookDir, 'original.epub');

const result = await parseBook(sourceFile, 'epub', bookDir);
console.log('Title:', result.title);
console.log('Author:', result.author);
console.log('Total chapters:', result.chapters.length);
result.chapters.slice(0, 15).forEach((ch: any, i: number) => console.log('  #' + (i+1) + ':', ch.title, '(' + ch.href + ')'));
