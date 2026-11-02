package com.example

class KotlinService {
    fun computeSum(a: Int, b: Int): Int {
        return a + b
    }

    fun interopGreeting(name: String): String {
        return JavaGreeter.greet(name) + " (via Kotlin)"
    }
}

fun main(args: Array<String>) {
    val service = KotlinService()
    val sum = service.computeSum(10, 25)
    val greeting = service.interopGreeting("IntelliJ")
    println("KOTLIN_MAIN_OUTPUT=sum:" + sum + ",greeting:" + greeting)
    println("KOTLIN_JAVA_VERSION=" + System.getProperty("java.version"))
}
