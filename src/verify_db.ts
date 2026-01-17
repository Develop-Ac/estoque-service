import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        console.log('Connecting to database...');
        const count = await prisma.est_contagem.count();
        console.log(`Total records in est_contagem: ${count}`);

        const activeCount = await prisma.est_contagem.count({
            where: { status: 0 }
        });
        console.log(`Records with status=0: ${activeCount}`);

        const inactiveCount = await prisma.est_contagem.count({
            where: { status: 1 }
        });
        console.log(`Records with status=1: ${inactiveCount}`);

        if (count > 0) {
            const first = await prisma.est_contagem.findFirst();
            console.log('First record sample:', JSON.stringify(first, null, 2));
        }
    } catch (e) {
        console.error('Error querying database:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
